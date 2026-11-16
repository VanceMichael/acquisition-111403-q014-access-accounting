import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startSource} from '../provider/server.mjs';
import {createClient} from '../src/source.mjs';
import {collectRecords} from '../src/reader.mjs';
import {openArchive} from '../src/archive.mjs';
import {startIntake} from '../src/app.mjs';
import {counterView,deriveUsage,mergeObservations,normalizeObservation} from '../src/usage.mjs';
import {routes} from '../fixtures/source.mjs';

const fixtureRecords = [...routes[0].body.records, ...routes[1].body.records];

function observation(patch) {
  return normalizeObservation({
    collector:'a',packetIdentifier:1,nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,
    status:'Start',sessionTime:0,eventTime:10,delayTime:0,inputOctets:0,inputGigawords:0,
    userPseudonym:'local1',...patch
  });
}

function usage(patch, extra = []) {
  return deriveUsage([observation(patch), ...extra.map(item => normalizeObservation(item))]);
}

test('来源记录页完整读取并保留设备启动、业务会话与投递身份', async () => {
  const source = await startSource();
  try {
    const client = createClient(source.origin);
    const result = await collectRecords(client);
    assert.equal(result.observations.length, 4);
    assert.deepEqual(result.pages.map(page => page.count), [2, 2]);
    const boots = result.observations.map(item => item.identities.boot?.id);
    assert.deepEqual([...new Set(boots)].sort(), ['boot:nas1:boot1','boot:nas1:boot2']);
    const sessions = result.observations.map(item => item.identities.session?.id);
    assert.equal(new Set(sessions).size, 2, '同一会话号在重启后属于不同启动身份');
    assert.ok(result.observations.every(item => item.identities.delivery.id?.startsWith('delivery:')));
  } finally { await source.close(); }
});

test('结束记录只关闭同一启动身份下的会话，迟到Stop不关闭重启后的新会话', async () => {
  const result = deriveUsage(fixtureRecords);
  assert.equal(result.sessions.length, 2);
  const oldBoot = result.sessions.find(session => session.nasBoot === 'boot1');
  const newBoot = result.sessions.find(session => session.nasBoot === 'boot2');
  assert.equal(oldBoot.state, 'closed');
  assert.equal(oldBoot.complete, true);
  assert.equal(oldBoot.usage.confirmedOctetsExact, '4294967346');
  assert.equal(oldBoot.usage.confirmedDurationSeconds, 25);
  assert.equal(newBoot.state, 'open');
  assert.equal(newBoot.stopped, false);
  assert.equal(newBoot.reviewCodes.includes('stop-without-start'), false);
});

test('重试换传输编号仍视为同一事件并保留全部投递凭据', async () => {
  const first = observation({});
  const retried = {...first, collector:'b', packetIdentifier:88, delayTime:10};
  const merged = mergeObservations([first, retried]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].deliveryIds.sort(), ['delivery:a:1','delivery:b:88']);
  assert.equal(merged[0].counters.inputGigawords, 0);
  const result = deriveUsage([
    {...first},
    {...observation({status:'Stop',sessionTime:25,eventTime:35,inputOctets:50,inputGigawords:1})}
  ]);
  assert.equal(result.reviews.length, 0);
  assert.equal(result.summary.confirmedOctetsExact, '4294967346');
});

test('重试投递缺少高位时沿用同一事件的完整计数', () => {
  const withHigh = observation({status:'Interim-Update',sessionTime:20,eventTime:30,inputOctets:10,inputGigawords:1});
  const withoutHigh = {...withHigh, inputGigawords:undefined, collector:'b', packetIdentifier:88};
  const merged = mergeObservations([withHigh, withoutHigh]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].counterVariants.length, 2);
  assert.equal(merged[0].counters.inputGigawordsPresent, true);
  assert.equal(merged[0].counters.inputGigawords, 1);
  const result = deriveUsage([observation({}), withHigh, withoutHigh]);
  assert.equal(result.segments[0].octetsExact, '4294967306');
  assert.equal(result.reviews.length, 0);
});

test('同一事件的不同投递高位冲突时不择一采用', () => {
  const first = observation({status:'Interim-Update',sessionTime:20,eventTime:30,inputOctets:10,inputGigawords:1});
  const second = {...first, collector:'b', packetIdentifier:88, delayTime:5, inputGigawords:2};
  const result = deriveUsage([observation({}), first, second]);
  assert.equal(result.segments[0].octets, null);
  assert.equal(result.segments[0].octetsStatus, 'unconfirmed');
  assert.equal(result.segments[0].octetsReason, 'delivery-counter-conflict');
  assert.ok(result.reviews.some(review => review.code === 'delivery-counter-conflict'));
});

test('低32位回绕按高位还原，不把倒退直接算成负数', async () => {
  const before = counterView({inputOctets:4294967290,inputGigawords:0});
  const after = counterView({inputOctets:9,inputGigawords:1});
  assert.equal(before.totalExact, '4294967290');
  assert.equal(after.totalExact, '4294967305');
  assert.equal(after.total - before.total, 15n);
  const result = deriveUsage([
    {nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Start',sessionTime:0,eventTime:10,delayTime:0,inputOctets:4294967290,inputGigawords:0},
    {nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Interim-Update',sessionTime:10,eventTime:20,delayTime:0,inputOctets:9,inputGigawords:1}
  ]);
  const segment = result.segments[0];
  assert.equal(segment.octetsExact, '15');
  assert.equal(segment.octetsStatus, 'confirmed');
});

test('缺少高位时保留原始低位，不推断回绕，也不补一整圈', async () => {
  const record = {nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Start',sessionTime:0,eventTime:10,delayTime:0,inputOctets:5000};
  const view = counterView(record);
  assert.equal(view.highPresent, false);
  assert.equal(view.valid, false);
  assert.equal(view.reason, 'missing-high-water-mark');
  assert.equal(view.total, null);
  assert.equal(view.low, 5000);
  const normalized = normalizeObservation(record);
  assert.equal(normalized.counters.inputGigawordsPresent, false);
  assert.equal(Object.hasOwn(normalized.counters, 'inputGigawords'), true);
  assert.equal(normalized.counters.inputGigawords, null);
});

test('缺高位的前置观测不做跨回绕补算，段用量留给资料岗核对', async () => {
  const result = deriveUsage([
    {nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Start',sessionTime:0,eventTime:10,delayTime:0,inputOctets:4000000000},
    {nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Interim-Update',sessionTime:10,eventTime:20,delayTime:0,inputOctets:100,inputGigawords:0}
  ]);
  const segment = result.segments[0];
  assert.equal(segment.octets, null);
  assert.equal(segment.octetsStatus, 'unconfirmed');
  assert.equal(segment.octetsReason, 'missing-high-water-mark');
  assert.ok(result.reviews.some(review => review.code === 'missing-high-water-mark'));
  assert.equal(result.summary.confirmedOctetsExact, '0');
});

test('累计计数倒退既不记为负数，也不自动补圈', async () => {
  const result = deriveUsage([
    {nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Start',sessionTime:10,eventTime:10,delayTime:0,inputOctets:100,inputGigawords:2},
    {nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Interim-Update',sessionTime:5,eventTime:20,delayTime:0,inputOctets:50,inputGigawords:1}
  ]);
  const segment = result.segments[0];
  assert.equal(segment.octets, null);
  assert.equal(segment.octetsStatus, 'unconfirmed');
  assert.equal(segment.octetsReason, 'counter-regressed');
  assert.equal(segment.durationSeconds, null);
  assert.equal(segment.durationReason, 'session-time-regressed');
  assert.ok(result.reviews.some(review => review.code === 'counter-regressed'));
});

test('缺少设备启动身份时仍保留原始资料，但会话归属标为待核对', async () => {
  const result = deriveUsage([
    {nas:'nas1',sessionId:'s1',port:3,status:'Start',sessionTime:0,eventTime:10,delayTime:0,inputOctets:0,inputGigawords:0}
  ]);
  assert.equal(result.summary.uncertainSessions, 1);
  assert.ok(result.sessions[0].reviewCodes.includes('missing-boot-identity'));
  assert.ok(result.reviews.some(review => review.code === 'missing-boot-identity'));
});

test('缺少来源时间时只保留接收顺序，不据此确认用量次序', async () => {
  const result = deriveUsage([
    {nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Start',sessionTime:0,delayTime:0,inputOctets:0,inputGigawords:0},
    {nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Interim-Update',sessionTime:10,inputOctets:10,inputGigawords:0}
  ]);
  const segment = result.segments[0];
  assert.equal(segment.octetsStatus, 'unconfirmed');
  assert.equal(segment.octetsReason, 'source-time-missing');
  assert.ok(result.reviews.some(review => review.code === 'source-time-missing'));
});

test('晚到结束记录不会覆盖新会话的开放状态', async () => {
  const oldBoot = observation({status:'Start'});
  const newBoot = observation({nasBoot:'boot2',packetIdentifier:3,status:'Start',eventTime:40});
  const lateStop = observation({nasBoot:'boot1',packetIdentifier:88,collector:'b',status:'Stop',sessionTime:25,eventTime:35,delayTime:10,inputOctets:50,inputGigawords:1});
  const result = deriveUsage([newBoot, lateStop, oldBoot]);
  const oldSession = result.sessions.find(session => session.nasBoot === 'boot1');
  const newSession = result.sessions.find(session => session.nasBoot === 'boot2');
  assert.equal(oldSession.state, 'closed');
  assert.equal(newSession.state, 'open');
  assert.equal(newSession.stopObservationId, null);
  assert.equal(newSession.usage.segments.length, 0);
});

test('缺少Start的结束记录不确认完整会话用量', async () => {
  const result = deriveUsage([
    {collector:'b',packetIdentifier:88,nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Stop',sessionTime:25,eventTime:35,delayTime:10,inputOctets:50,inputGigawords:1}
  ]);
  assert.equal(result.sessions[0].state, 'uncertain');
  assert.equal(result.sessions[0].complete, false);
  assert.ok(result.reviews.some(review => review.code === 'stop-without-start'));
});

test('分段详情保留原始累计计数、累计时长和来源时间依据', async () => {
  const result = deriveUsage(fixtureRecords);
  const oldBoot = result.sessions.find(session => session.nasBoot === 'boot1');
  const [first, second] = oldBoot.usage.segments;
  assert.deepEqual(first.from, {
    observationId: oldBoot.observationIds[0], status:'Start', eventTime:10, delayTime:0,
    inputOctets:0, inputGigawords:0, inputGigawordsPresent:true, sessionTime:0,
    totalOctets:'0', totalOctetsNumber:0
  });
  assert.equal(first.to.inputOctets, 10);
  assert.equal(first.to.inputGigawords, 1);
  assert.equal(first.to.totalOctets, '4294967306');
  assert.equal(second.from.eventTime, 30);
  assert.equal(second.to.eventTime, 35);
  assert.equal(second.to.delayTime, 10);
  assert.deepEqual(second.evidence, oldBoot.observationIds.slice(1));
});

test('接收恢复与补件后按事件合并，重复领取不新增观测', async () => {
  const directory = await mkdtemp(join(tmpdir(),'usage-archive-'));
  const source = await startSource();
  try {
    const intake = await startIntake({origin:source.origin,directory});
    try {
      const first = await (await fetch(intake.origin+'/collect-records',{method:'POST'})).json();
      assert.equal(first.observations, 4);
      assert.equal(first.closedSessions, 1);
      assert.equal(first.openSessions, 1);
      const second = await (await fetch(intake.origin+'/collect-records',{method:'POST'})).json();
      assert.equal(second.observations, 4);
      const reopened = await openArchive(directory);
      assert.equal(reopened.observations().length, 4);
      const usage = await (await fetch(intake.origin+'/usage')).json();
      assert.equal(usage.sessions.length, 2);
      assert.equal(usage.reviews.length, 0);
      assert.equal(usage.summary.confirmedOctetsExact, '4294967346');
    } finally { await intake.close(); }
  } finally { await source.close(); await rm(directory,{recursive:true,force:true}); }
});

test('外部阶段切换后不补造缺失高位，并保留待核对项目', async () => {
  const directory = await mkdtemp(join(tmpdir(),'usage-phase-'));
  const source = await startSource();
  try {
    source.setPhase('unknown-high');
    const intake = await startIntake({origin:source.origin,directory});
    try {
      const collected = await (await fetch(intake.origin+'/collect-records',{method:'POST'})).json();
      assert.equal(collected.observations, 4);
      const usage = await (await fetch(intake.origin+'/usage')).json();
      const affected = usage.sessions.flatMap(session => session.usage.segments)
        .filter(segment => segment.octetsReason === 'missing-high-water-mark');
      assert.ok(affected.length >= 2);
      assert.ok(affected.every(segment => segment.octets === null));
      assert.ok(usage.reviews.every(review => review.sessionId));
      assert.equal(usage.summary.completeSessions, 0);
      const review = await (await fetch(intake.origin+'/reviews')).json();
      assert.ok(review.some(item => item.code === 'missing-high-water-mark'));
      const observations = await (await fetch(intake.origin+'/observations')).json();
      assert.equal(observations.length, 4);
      const withoutHigh = observations.filter(item => !item.counters.inputGigawordsPresent);
      assert.deepEqual(withoutHigh.map(item => item.eventTime), [30]);
      assert.ok(withoutHigh.every(item => item.counters.inputGigawords === null));
    } finally { await intake.close(); }
  } finally { await source.close(); await rm(directory,{recursive:true,force:true}); }
});

test('来源页循环不会被静默当成完整资料', async () => {
  const client = async () => ({records:[{nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Start'}],next:'/accounting-records?cursor=0'});
  client.origin = 'http://127.0.0.1:1';
  await assert.rejects(() => collectRecords(client), error => error.code === 'cursor-loop');
});

test('查询接口不共享归档内部对象', async () => {
  const directory = await mkdtemp(join(tmpdir(),'usage-clone-'));
  const archive = await openArchive(directory);
  try {
    await archive.commitObservations([observation({})], []);
    const listed = archive.observations();
    listed[0].inputOctets = 999;
    assert.equal(archive.observations()[0].inputOctets, 0);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('同一会话号在重启后不复用结束依据', () => {
  const fixture = deriveUsage(fixtureRecords);
  const oldBoot = fixture.sessions.find(session => session.nasBoot === 'boot1');
  const newBoot = fixture.sessions.find(session => session.nasBoot === 'boot2');
  assert.notEqual(oldBoot.id, newBoot.id);
  assert.equal(newBoot.observationIds.length, 1);
  assert.equal(newBoot.closedBy, null);
  assert.equal(newBoot.stopObservationId, null);
});

test('重复Start不能自动判定会话边界', () => {
  const result = usage({status:'Start',sessionTime:0,eventTime:10}, [
    {nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Start',sessionTime:0,eventTime:12,delayTime:0,inputOctets:0,inputGigawords:0,packetIdentifier:2},
    {nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Stop',sessionTime:10,eventTime:20,delayTime:0,inputOctets:10,inputGigawords:0,packetIdentifier:3}
  ]);
  assert.equal(result.sessions[0].state, 'uncertain');
  assert.equal(result.sessions[0].complete, false);
  assert.ok(result.reviews.some(review => review.code === 'multiple-start'));
  assert.ok(result.segments.every(segment => segment.octetsStatus === 'unconfirmed'));
});

test('缺Start但有多条中间观测时各段都不确认', () => {
  const result = deriveUsage([
    {nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Interim-Update',sessionTime:10,eventTime:10,delayTime:0,inputOctets:10,inputGigawords:0,packetIdentifier:1},
    {nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Stop',sessionTime:20,eventTime:20,delayTime:0,inputOctets:20,inputGigawords:0,packetIdentifier:2}
  ]);
  assert.equal(result.sessions[0].state, 'uncertain');
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].octetsStatus, 'unconfirmed');
  assert.equal(result.segments[0].octetsReason, 'session-start-missing');
  assert.equal(result.summary.confirmedOctetsExact, '0');
});

test('零用量会话也能确认，且不使用未声明的推断', () => {
  const result = deriveUsage([
    {collector:'a',nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Start',sessionTime:0,eventTime:10,delayTime:0,inputOctets:0,inputGigawords:0,packetIdentifier:1},
    {collector:'a',nas:'nas1',nasBoot:'boot1',sessionId:'s1',port:3,status:'Stop',sessionTime:0,eventTime:20,delayTime:0,inputOctets:0,inputGigawords:0,packetIdentifier:2}
  ]);
  assert.equal(result.sessions[0].state, 'closed');
  assert.equal(result.sessions[0].complete, true);
  assert.equal(result.segments[0].octetsExact, '0');
  assert.equal(result.segments[0].durationSeconds, 0);
});

test('派生用量只读归档，不修改原始观测', async () => {
  const directory = await mkdtemp(join(tmpdir(),'usage-pure-'));
  const archive = await openArchive(directory);
  try {
    await archive.commitObservations(fixtureRecords.map(record => normalizeObservation(record)), []);
    const before = archive.observations();
    const result = deriveUsage(archive.observations());
    assert.ok(result.sessions.length > 0);
    assert.deepEqual(archive.observations(), before);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
