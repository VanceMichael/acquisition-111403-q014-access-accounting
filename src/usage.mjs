import {createHash} from 'node:crypto';

const GIGAWORD = 1n << 32n;
const MAX_LOW = 0xffffffff;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const digest = value => createHash('sha256').update(value).digest('hex');
const present = value => value !== undefined && value !== null;
const finite = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
const safeNumber = value => value <= BigInt(MAX_SAFE) ? Number(value) : null;

function integer(value, maximum = MAX_SAFE) {
  const parsed = finite(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
}

/** 规范化用于去重的数值；无法解释的原始值原样保留在观测中。 */
function canonical(value) {
  const parsed = finite(value);
  return parsed === null ? value ?? null : parsed;
}

function observationKey(record) {
  const status = statusKind(record.status);
  return JSON.stringify([
    record.nas ?? null, record.nasBoot ?? null, record.sessionId ?? null, record.port ?? null,
    status === 'unknown' ? ['unknown', canonical(record.status)] : status,
    canonical(record.eventTime), canonical(record.sessionTime), canonical(record.inputOctets),
    record.userPseudonym ?? null
  ]);
}

/** 高位是否出现属于投递差异；同一事件的多次投递各自保留原始计数器。 */
function counterVariant(record,delivery) {
  return {
    inputOctets: present(record.inputOctets) ? record.inputOctets : null,
    inputGigawords: Object.hasOwn(record,'inputGigawords') && present(record.inputGigawords) ? record.inputGigawords : null,
    inputGigawordsPresent: Object.hasOwn(record,'inputGigawords') && present(record.inputGigawords),
    sessionTime: present(record.sessionTime) ? record.sessionTime : null,
    deliveryId: deliveryIdentityOf(delivery)
  };
}

function mergeCounterVariants(variants) {
  const unique = new Map();
  for (const variant of variants) {
    if (!variant || typeof variant !== 'object') continue;
    unique.set(JSON.stringify([variant.inputOctets,variant.inputGigawords,variant.inputGigawordsPresent,variant.sessionTime,variant.deliveryId]),variant);
  }
  return [...unique.values()];
}

/**
 * 合并后的观测取用唯一出现的高位；多个投递声明了不同高位时
 * 不择一采用，而是标为冲突并留待核对。
 */
function effectiveCounters(observation) {
  const variants = observation.counterVariants ?? [counterVariant(observation,{collector:observation.collector,packetIdentifier:observation.packetIdentifier,delayTime:observation.delayTime,eventTime:observation.eventTime})];
  const declared = variants.filter(variant => variant.inputGigawordsPresent);
  const highs = new Set(declared.map(variant => String(canonical(variant.inputGigawords))));
  if (highs.size > 1) {
    return {
      counters:{...observation.counters,inputGigawords:null,inputGigawordsPresent:false},
      conflict:{
        code:'delivery-counter-conflict',
        values:[...declared.map(variant => ({inputGigawords:variant.inputGigawords,deliveryId:variant.deliveryId}))]
      }
    };
  }
  const chosen = declared[0] ?? variants[0];
  return {
    counters:{
      inputOctets: chosen?.inputOctets ?? observation.counters.inputOctets,
      inputGigawords: chosen?.inputGigawords ?? null,
      inputGigawordsPresent: Boolean(chosen?.inputGigawordsPresent),
      sessionTime: chosen?.sessionTime ?? observation.counters.sessionTime
    },
    conflict:null
  };
}

function countersOf(observation) {
  return effectiveCounters(observation).counters;
}

/**
 * 投递身份由转发方与传输编号决定，传输编号可因重试而变化。
 * 来源位置与接收顺序只作溯源凭据，不参与投递去重。
 */
function deliveryKey(delivery) {
  return JSON.stringify([
    delivery.collector ?? null, delivery.packetIdentifier ?? null,
    canonical(delivery.delayTime), canonical(delivery.eventTime)
  ]);
}

function normalizeDelivery(delivery) {
  return {
    collector: delivery?.collector ?? null,
    packetIdentifier: delivery?.packetIdentifier ?? null,
    delayTime: delivery?.delayTime ?? null,
    eventTime: delivery?.eventTime ?? null,
    sourcePath: delivery?.sourcePath ?? null,
    sourceIndex: delivery?.sourceIndex ?? null
  };
}

function mergeDeliveries(deliveries) {
  const unique = new Map();
  for (const item of deliveries) {
    if (!item || typeof item !== 'object') continue;
    const delivery = normalizeDelivery(item);
    unique.set(deliveryKey(delivery), delivery);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, delivery]) => delivery);
}

function deliveryIdentityOf(delivery) {
  return delivery.collector !== null && delivery.packetIdentifier !== null
    ? `delivery:${delivery.collector}:${delivery.packetIdentifier}`
    : null;
}

/** 投递合并后同步第一投递视图，避免沿用合并前的单一投递身份。 */
function refreshDeliveryViews(observation) {
  observation.deliveries = mergeDeliveries(observation.deliveries);
  observation.deliveryIds = observation.deliveries.map(deliveryIdentityOf).filter(Boolean);
  const primary = observation.deliveries[0] ?? normalizeDelivery({});
  observation.identities.delivery = {
    id:deliveryIdentityOf(primary),
    collector:primary.collector,
    packetIdentifier:primary.packetIdentifier
  };
  observation.deliveryKey = deliveryIdentityOf(primary);
  return observation;
}

export function statusKind(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) {
    return ({1:'start',2:'stop',3:'interim'})[Number(value)] || 'unknown';
  }
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (status === 'start') return 'start';
  if (status === 'stop') return 'stop';
  if (status === 'interim-update' || status === 'interim' || status === 'update') return 'interim';
  return 'unknown';
}

function sourceDelivery(record) {
  const source = record.source && typeof record.source === 'object' ? record.source : {};
  return {
    collector: record.collector ?? null,
    packetIdentifier: record.packetIdentifier ?? null,
    delayTime: record.delayTime ?? null,
    eventTime: record.eventTime ?? null,
    sourcePath: source.path ?? null,
    sourceIndex: source.index ?? null
  };
}

export function normalizeObservation(record) {
  if (!record || typeof record !== 'object') throw new Error('资料记录必须是对象');
  const raw = {...record};
  for (const key of ['deliveries','observationKey','identities','bootKey','sessionKey','deliveryKey','deliveryIds','timing','counters','counterVariants','statusKind']) {
    delete raw[key];
  }  const key = observationKey(raw);
  const nas = present(raw.nas) ? raw.nas : null;
  const nasBoot = present(raw.nasBoot) ? raw.nasBoot : null;
  const sessionId = present(raw.sessionId) ? raw.sessionId : null;
  const port = present(raw.port) ? raw.port : null;
  const boot = nas !== null && nasBoot !== null
    ? {id:`boot:${nas}:${nasBoot}`,nas,nasBoot}
    : null;
  const session = boot && sessionId !== null
    ? {id:`session:${nas}:${nasBoot}:${sessionId}:${port === null ? '?' : port}`,nas,nasBoot,sessionId,port}
    : null;
  const deliveries = mergeDeliveries([
    ...(Array.isArray(record.deliveries) ? record.deliveries : []),
    sourceDelivery(raw)
  ]);
  const primary = deliveries[0] ?? normalizeDelivery({});
  const eventTime = finite(raw.eventTime);
  const delayTime = finite(raw.delayTime);
  return {
    ...raw,
    id: raw.id && typeof raw.id === 'string' ? raw.id : 'obs_' + digest(key).slice(0, 32),
    observationKey: key,
    identities: {
      delivery: {
        id: deliveryIdentityOf(primary),
        collector: primary.collector,
        packetIdentifier: primary.packetIdentifier
      },
      boot,
      session
    },
    bootKey: boot?.id ?? null,
    sessionKey: session?.id ?? null,
    deliveryKey: deliveryIdentityOf(primary),
    deliveries,
    deliveryIds: deliveries.map(deliveryIdentityOf).filter(Boolean),
    timing: {
      eventTime: present(raw.eventTime) ? raw.eventTime : null,
      delayTime: present(raw.delayTime) ? raw.delayTime : null,
      eventTimeValid: eventTime !== null,
      delayTimeValid: delayTime !== null,
      sourceReceiveBasis: eventTime !== null && delayTime !== null ? eventTime + delayTime : null
    },
    counters: {
      inputOctets: present(raw.inputOctets) ? raw.inputOctets : null,
      inputGigawords: present(raw.inputGigawords) ? raw.inputGigawords : null,
      inputGigawordsPresent: Object.hasOwn(raw, 'inputGigawords') && present(raw.inputGigawords),
      sessionTime: present(raw.sessionTime) ? raw.sessionTime : null
    },
    counterVariants: mergeCounterVariants([
      ...(Array.isArray(record.counterVariants) ? record.counterVariants : []),
      counterVariant(raw,primary)
    ]),
    statusKind: statusKind(raw.status)
  };
}

/** 同一来源事件的重试投递合并为一份观测，所有投递身份并列保留。 */
export function mergeObservations(records) {
  const groups = new Map();
  for (const record of records) {
    const observation = normalizeObservation(record);
    const key = observation.observationKey;
    const existing = groups.get(key);
    if (!existing) groups.set(key, observation);
    else {
      existing.deliveries = [...existing.deliveries, ...observation.deliveries];
      existing.counterVariants = mergeCounterVariants([...existing.counterVariants, ...observation.counterVariants]);
    }
  }
  return [...groups.values()].map(observation => {
    refreshDeliveryViews(observation);
    observation.counters = countersOf(observation);
    return observation;
  });
}

/**
 * 把32位低位与可选高位还原为精确累计值。
 * 高位缺失时只保留低位，不推断回绕次数，也不补整圈。
 */
export function counterView(record) {
  const lowPresent = present(record.inputOctets);
  const low = integer(record.inputOctets, MAX_LOW);
  const highPresent = Object.hasOwn(record, 'inputGigawords') && present(record.inputGigawords);
  const high = highPresent ? integer(record.inputGigawords, MAX_LOW) : null;
  let reason = null;
  if (!lowPresent) reason = 'missing-low-counter';
  else if (low === null) reason = 'invalid-low-counter';
  else if (!highPresent) reason = 'missing-high-water-mark';
  else if (high === null) reason = 'invalid-high-water-mark';
  const total = reason === null ? BigInt(high) * GIGAWORD + BigInt(low) : null;
  return {
    lowPresent,
    low: low === null ? record.inputOctets ?? null : low,
    lowValid: low !== null,
    highPresent,
    high: high === null ? record.inputGigawords ?? null : high,
    highValid: high !== null,
    total,
    totalExact: total === null ? null : total.toString(),
    totalNumber: total === null ? null : safeNumber(total),
    valid: reason === null,
    reason
  };
}

function durationView(record) {
  const value = integer(record.sessionTime, MAX_SAFE);
  return {
    valid: value !== null,
    seconds: value,
    raw: present(record.sessionTime) ? record.sessionTime : null
  };
}

function snapshot(observation) {
  const counters = countersOf(observation);
  const counter = counterView(counters);
  return {
    observationId: observation.id,
    status: observation.status ?? null,
    eventTime: observation.timing.eventTime,
    delayTime: observation.timing.delayTime,
    inputOctets: counters.inputOctets,
    inputGigawords: counters.inputGigawords,
    inputGigawordsPresent: counters.inputGigawordsPresent,
    sessionTime: counters.sessionTime,
    totalOctets: counter.totalExact,
    totalOctetsNumber: counter.totalNumber
  };
}

function orderObservations(observations) {
  return observations
    .map((observation,index) => ({observation,index,eventTime:finite(observation.timing.eventTime)}))
    .sort((left,right) => {
      if (left.eventTime !== null && right.eventTime !== null) {
        return left.eventTime === right.eventTime ? left.index - right.index : left.eventTime - right.eventTime;
      }
      if (left.eventTime !== null) return -1;
      if (right.eventTime !== null) return 1;
      return left.index - right.index;
    })
    .map(item => item.observation);
}

/** 观测次序由来源事件时间决定；缺失时间或时间相同才退回接收顺序。 */
function observationsOf(group) {
  return orderObservations(group.observations);
}

function compareCounters(previous,current) {
  const before = counterView(countersOf(previous));
  const after = counterView(countersOf(current));
  if (!before.valid) return {status:'unconfirmed',reason:before.reason,deltaExact:null};
  if (!after.valid) return {status:'unconfirmed',reason:after.reason,deltaExact:null};
  const delta = after.total - before.total;
  if (delta < 0n) return {status:'unconfirmed',reason:'counter-regressed',deltaExact:null};
  return {status:'confirmed',reason:null,deltaExact:delta.toString()};
}

function compareDuration(previous,current) {
  const before = durationView(countersOf(previous));
  const after = durationView(countersOf(current));
  if (!before.valid || !after.valid) return {status:'unconfirmed',reason:'session-time-missing',delta:null};
  const delta = after.seconds - before.seconds;
  if (delta < 0) return {status:'unconfirmed',reason:'session-time-regressed',delta:null};
  return {status:'confirmed',reason:null,delta};
}

const REVIEW_MESSAGES = {
  'identity-ambiguous':'设备启动、业务会话或端口身份不完整，不能把该观测归入可确认会话。',
  'missing-boot-identity':'缺少设备启动身份，无法判断重启前后的会话归属。',
  'missing-session-identity':'缺少业务会话标识，不能确认会话边界。',
  'missing-port':'接入端口缺失，不能确认同端口会话关系。',
  'delivery-identity-missing':'投递身份不完整，原文可留存但无法完整追溯投递方。',
  'source-time-missing':'缺少来源事件时间，只能保留接收顺序，不能据此确认用量次序。',
  'source-time-invalid':'来源事件时间不是有效的非负时间，不能据此确认用量次序。',
  'source-time-duplicate':'同一会话存在相同来源事件时间的多条观测，用量次序需人工核对。',
  'session-start-missing':'会话没有观测到可用的Start，首个累计值之前与起始基准无法确认。',
  'stop-without-start':'结束记录没有对应的Start，不能确认完整会话用量。',
  'stop-before-start':'结束记录早于同一身份的Start，会话归属存在歧义。',
  'multiple-start':'同一设备启动身份和会话出现多次Start，不能自动判断是否重启了会话。',
  'multiple-stop':'同一会话出现多条Stop，只采用最早一条作为结束依据。',
  'observation-after-stop':'结束之后仍有同会话的非结束观测，不能自动并入已结束用量。',
  'unknown-status':'记录状态不在已知范围内，未用于会话边界判断。',
  'missing-high-water-mark':'缺少32位高位累计值，不能推定量程回绕或确定精确用量。',
  'missing-low-counter':'缺少32位低位累计值，不能计算用量。',
  'invalid-low-counter':'低位累计值不是有效的32位非负整数，不能计算用量。',
  'invalid-high-water-mark':'高位累计值无效，不能计算用量。',
  'counter-regressed':'累计计数倒退；未按负数计算，也未擅自补一整圈。',
  'delivery-counter-conflict':'同一事件的不同投递声明了互相冲突的高位累计值，未择一采用。',
  'session-time-missing':'累计时长缺失或无效，不能计算该段时长。',
  'session-time-regressed':'累计时长倒退，未按负数计算。'
};

function addReview(reviews, code, {sessionId=null,observationIds=[],details={}} = {}) {
  const item = {
    id:'review_' + digest(JSON.stringify([code,sessionId,observationIds,details])).slice(0, 24),
    code,
    message:REVIEW_MESSAGES[code] || code,
    sessionId,
    observationIds,
    details
  };
  if (!reviews.some(existing => existing.id === item.id)) reviews.push(item);
  return item;
}

function identityOf(observation) {
  const nas = present(observation.nas) ? observation.nas : null;
  const nasBoot = present(observation.nasBoot) ? observation.nasBoot : null;
  const sessionId = present(observation.sessionId) ? observation.sessionId : null;
  const port = present(observation.port) ? observation.port : null;
  return {
    nas,nasBoot,sessionId,port,
    complete:nas !== null && nasBoot !== null && sessionId !== null && port !== null,
    key:JSON.stringify([nas,nasBoot,sessionId,port])
  };
}

function sessionIdOf(identity) {
  return 'session_' + digest(identity.key).slice(0, 24);
}

function bootOf(identity) {
  return identity.nas !== null && identity.nasBoot !== null
    ? {id:`boot:${identity.nas}:${identity.nasBoot}`,nas:identity.nas,nasBoot:identity.nasBoot}
    : null;
}

function sessionIdentityOf(identity) {
  return identity.sessionId !== null
    ? {id:`session:${identity.nas}:${identity.nasBoot}:${identity.sessionId}:${identity.port === null ? '?' : identity.port}`,
      nas:identity.nas,nasBoot:identity.nasBoot,sessionId:identity.sessionId,port:identity.port}
    : null;
}

function sessionView(group,reviews) {
  const {id,identity} = group;
  const ordered = observationsOf(group);  const observationIds = ordered.map(observation => observation.id);
  const starts = ordered.flatMap((observation,index) => observation.statusKind === 'start' ? [index] : []);
  const stops = ordered.flatMap((observation,index) => observation.statusKind === 'stop' ? [index] : []);
  const firstStart = starts[0] ?? -1;
  const secondStart = starts[1] ?? -1;
  const stopAfterStart = stops.find(index => firstStart !== -1 && index > firstStart) ?? -1;
  const stopBeforeStart = firstStart !== -1 && stops.some(index => index < firstStart);
  const laterObservations = stopAfterStart === -1 ? [] : ordered.slice(stopAfterStart + 1);
  const nonStopAfterStop = laterObservations.filter(observation => observation.statusKind !== 'stop');
  const codes = new Set();
  const note = (code,options) => {
    codes.add(code);
    addReview(reviews,code,{sessionId:id,...options});
  };

  if (!identity.complete) {
    note('identity-ambiguous',{observationIds});
    if (identity.nas === null || identity.nasBoot === null) note('missing-boot-identity',{observationIds});
    if (identity.sessionId === null) note('missing-session-identity',{observationIds});
    if (identity.port === null) note('missing-port',{observationIds});
  }

  // 同一来源时间仍有多条观测（身份或状态不同）时，先后次序无法由来源时间确定。
  const eventTimeCounts = new Map();
  for (const observation of ordered) {
    if (!observation.timing.eventTimeValid) {
      note('source-time-missing',{observationIds:[observation.id]});
      continue;
    }
    const key = String(observation.timing.eventTime);
    const bucket = eventTimeCounts.get(key) ?? [];
    bucket.push(observation);
    eventTimeCounts.set(key,bucket);
  }
  const ambiguousTimes = new Set();
  for (const [eventTime,group] of eventTimeCounts) {
    if (group.length === 1) continue;
    ambiguousTimes.add(eventTime);
    note('source-time-duplicate',{
      observationIds:group.map(observation => observation.id),
      details:{eventTime:finite(eventTime),count:group.length,statuses:group.map(observation => observation.status ?? null)}
    });
  }
  for (const observation of ordered) {
    const {conflict} = effectiveCounters(observation);
    if (conflict) {
      note(conflict.code,{observationIds:[observation.id],details:{values:conflict.values}});
    }
    if (observation.identities.delivery.collector === null || observation.identities.delivery.packetIdentifier === null) {
      note('delivery-identity-missing',{observationIds:[observation.id]});
    }
    if (observation.statusKind === 'unknown') {
      note('unknown-status',{observationIds:[observation.id],details:{status:observation.status ?? null}});
    }
    if (observation.timing.eventTimeValid && observation.timing.eventTime < 0) {
      note('source-time-invalid',{observationIds:[observation.id],details:{eventTime:observation.timing.eventTime}});
    }
  }

  if (firstStart === -1) {
    if (stops.length) note('stop-without-start',{observationIds:stops.map(index => ordered[index].id)});
    else note('session-start-missing',{observationIds});
  } else if (firstStart > 0) {
    note('session-start-missing',{observationIds:ordered.slice(0,firstStart).map(observation => observation.id),details:{startsAfterObservation:firstStart}});
  }
  if (stopBeforeStart) note('stop-before-start',{observationIds:stops.filter(index => index < firstStart).map(index => ordered[index].id)});
  if (secondStart !== -1) note('multiple-start',{observationIds:starts.map(index => ordered[index].id)});
  if (stops.length > 1) note('multiple-stop',{observationIds:stops.map(index => ordered[index].id)});
  if (laterObservations.length) {
    if (nonStopAfterStop.length) {
      note('observation-after-stop',{observationIds:nonStopAfterStop.map(observation => observation.id)});
    }
  }

  const startObservation = firstStart === -1 ? null : ordered[firstStart];
  const stopObservation = stopAfterStart === -1 ? null : ordered[stopAfterStart];
  const timeAvailable = startObservation?.timing.eventTimeValid === true &&
    stopObservation?.timing.eventTimeValid === true;

  let state;
  if (!identity.complete) state = 'uncertain';
  else if (secondStart !== -1) state = 'uncertain';
  else if (stopAfterStart !== -1 && nonStopAfterStop.length === 0 && !stopBeforeStart && timeAvailable) state = 'closed';
  else if (stopAfterStart !== -1) state = 'uncertain';
  else if (stops.length) state = 'uncertain';
  else if (ordered.some(observation => observation.statusKind === 'unknown')) state = 'uncertain';
  else state = 'open';

  const conflictTimes = new Set(ordered
    .filter(observation => effectiveCounters(observation).conflict)
    .map(observation => String(observation.timing.eventTime)));

  const segments = [];
  for (let index = 1;index < ordered.length;index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const octets = compareCounters(previous,current);
    const duration = compareDuration(previous,current);
    const problems = [];

    if (!identity.complete) problems.push('identity-ambiguous');
    if (!previous.timing.eventTimeValid || !current.timing.eventTimeValid) problems.push('source-time-missing');
    if (previous.timing.eventTime < 0 || current.timing.eventTime < 0) problems.push('source-time-invalid');
    if (ambiguousTimes.has(String(previous.timing.eventTime)) || ambiguousTimes.has(String(current.timing.eventTime))) {
      problems.push('source-time-duplicate');
    }
    if (conflictTimes.has(String(previous.timing.eventTime)) || conflictTimes.has(String(current.timing.eventTime))) {
      problems.push('delivery-counter-conflict');
    }
    if (firstStart === -1 || (firstStart > 0 && index - 1 < firstStart)) problems.push('session-start-missing');
    if (secondStart !== -1) problems.push('multiple-start');
    if (stopBeforeStart) problems.push('stop-before-start');
    if (stops.length > 1) problems.push('multiple-stop');
    if (ordered.some(observation => observation.statusKind === 'unknown')) problems.push('unknown-status');
    if (stopAfterStart !== -1 && index - 1 >= stopAfterStart) {
      problems.push(nonStopAfterStop.length ? 'observation-after-stop' : 'multiple-stop');
    }

    const octetsStatus = problems.length ? 'unconfirmed' : octets.status;
    const octetsReason = problems[0] ?? octets.reason;
    const durationStatus = problems.length ? 'unconfirmed' : duration.status;
    const durationReason = problems[0] ?? duration.reason;

    if (octetsStatus === 'unconfirmed') {
      note(octetsReason || 'identity-ambiguous',{
        observationIds:[previous.id,current.id],
        details:{fromEventTime:previous.timing.eventTime,toEventTime:current.timing.eventTime}
      });
    }
    if (durationStatus === 'unconfirmed') {
      note(durationReason || 'session-time-missing',{
        observationIds:[previous.id,current.id],
        details:{fromEventTime:previous.timing.eventTime,toEventTime:current.timing.eventTime}
      });
    }

    const octetsExact = octetsStatus === 'confirmed' ? octets.deltaExact : null;
    segments.push({
      id:'segment_' + digest(JSON.stringify([id,previous.id,current.id])).slice(0, 24),
      sessionId:id,
      from:snapshot(previous),
      to:snapshot(current),
      evidence:[previous.id,current.id],
      octets:octetsExact === null ? null : safeNumber(BigInt(octetsExact)),
      octetsExact,
      octetsStatus,
      octetsReason,
      durationSeconds:durationStatus === 'confirmed' ? duration.delta : null,
      durationStatus,
      durationReason,
      status:octetsStatus === 'confirmed' && durationStatus === 'confirmed'
        ? 'confirmed'
        : octetsStatus === 'confirmed' ? 'partially-confirmed' : 'unconfirmed',
      deliveryIds:[...new Set([...previous.deliveryIds,...current.deliveryIds])]
    });
  }

  let confirmedOctets = 0n;
  let confirmedDuration = 0;
  let confirmedCounterSegments = 0;
  for (const segment of segments) {
    if (segment.octetsExact !== null) {
      confirmedOctets += BigInt(segment.octetsExact);
      confirmedCounterSegments++;
    }
    if (segment.durationSeconds !== null) confirmedDuration += segment.durationSeconds;
  }

  const sessionReviews = reviews.filter(item => item.sessionId === id);
  const complete = state === 'closed' && identity.complete && firstStart === 0 &&
    stopAfterStart === ordered.length - 1 && segments.length > 0 &&
    segments.every(segment => segment.status === 'confirmed') && sessionReviews.length === 0;

  return {
    id,
    identities:{
      boot:bootOf(identity),
      session:sessionIdentityOf(identity),
      deliveries:mergeDeliveries(ordered.flatMap(observation => observation.deliveries)).map(delivery => ({
        id:deliveryIdentityOf(delivery),
        collector:delivery.collector,
        packetIdentifier:delivery.packetIdentifier,
        delayTime:delivery.delayTime,
        eventTime:delivery.eventTime
      }))
    },
    nas:identity.nas,
    nasBoot:identity.nasBoot,
    sessionId:identity.sessionId,
    port:identity.port,
    state,
    open:state === 'open',
    closed:state === 'closed',
    complete,
    started:firstStart !== -1,
    stopped:stops.length > 0,
    startObservationId:firstStart === -1 ? null : ordered[firstStart].id,
    stopObservationId:stopAfterStart === -1 ? null : ordered[stopAfterStart].id,
    closedBy:stopAfterStart === -1 ? null : ordered[stopAfterStart].id,
    observationIds,
    observationCount:ordered.length,
    observations:ordered,
    deliveries:mergeDeliveries(ordered.flatMap(observation => observation.deliveries)),
    firstEventTime:ordered[0]?.timing.eventTime ?? null,
    lastEventTime:ordered.at(-1)?.timing.eventTime ?? null,
    usage:{
      confirmedOctets:safeNumber(confirmedOctets),
      confirmedOctetsExact:confirmedOctets.toString(),
      confirmedDurationSeconds:confirmedDuration,
      confirmedCounterSegmentCount:confirmedCounterSegments,
      unconfirmedCounterSegmentCount:segments.length - confirmedCounterSegments,
      segments
    },
    reviewCodes:[...codes],
    reviewIds:sessionReviews.map(item => item.id)
  };
}

export function deriveUsage(records) {
  const observations = mergeObservations(records);
  const groups = new Map();
  for (const observation of observations) {
    const identity = identityOf(observation);
    const id = sessionIdOf(identity);
    let group = groups.get(id);
    if (!group) {
      group = {id,identity,observations:[]};
      groups.set(id,group);
    }
    group.observations.push(observation);
  }

  const reviews = [];
  const sessions = [];
  for (const group of groups.values()) sessions.push(sessionView(group,reviews));
  const segments = sessions.flatMap(session => session.usage.segments);

  let confirmedOctets = 0n;
  let confirmedDuration = 0;
  for (const segment of segments) {
    if (segment.octetsExact !== null) confirmedOctets += BigInt(segment.octetsExact);
    if (segment.durationSeconds !== null) confirmedDuration += segment.durationSeconds;
  }

  const summary = {
    observations:observations.length,
    sessions:sessions.length,
    openSessions:sessions.filter(session => session.state === 'open').length,
    closedSessions:sessions.filter(session => session.state === 'closed').length,
    uncertainSessions:sessions.filter(session => session.state === 'uncertain').length,
    completeSessions:sessions.filter(session => session.complete).length,
    confirmedSegments:segments.filter(segment => segment.status === 'confirmed').length,
    unconfirmedSegments:segments.filter(segment => segment.status !== 'confirmed').length,
    confirmedOctets:safeNumber(confirmedOctets),
    confirmedOctetsExact:confirmedOctets.toString(),
    confirmedDurationSeconds:confirmedDuration,
    reviews:reviews.length
  };
  return {sessions,segments,reviews,summary};
}

export const deriveSessions = records => deriveUsage(records).sessions;
