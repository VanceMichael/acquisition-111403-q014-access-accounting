import {mergeObservations, normalizeObservation} from './usage.mjs';

const DEFAULT_LIMIT = 1000;

function sourcePosition(url) {
  const target = new URL(url);
  const index = target.searchParams.get('cursor');
  if (index !== null && /^\d+$/.test(index)) return Number(index);
  return null;
}

function normalizePage(document) {
  if (!document || typeof document !== 'object' || !Array.isArray(document.records)) {
    throw new Error('来源记录页格式无效');
  }
  return {
    records:document.records,
    next:typeof document.next === 'string' ? document.next : null
  };
}

/**
 * 按来源 cursor 顺序读取全部记录页。每页只接受同一来源地址；
 * cursor 循环或页数异常时停止并报告，不静默丢弃后续资料。
 * onPage 在每页解析后调用，调用方可先行落盘，便于中断后恢复。
 * 同一页的原文凭据随页交出；回调不存在时凭据保留在 client.exchanges 中。
 */
export async function collectRecords(client, {maxPages=DEFAULT_LIMIT, start='/accounting-records?cursor=0', onPage}={}) {
  const pages = [];
  const observations = [];
  const seen = new Set();
  let path = start;

  while (path !== null) {
    if (pages.length >= maxPages) {
      const error = new Error('来源记录页超出上限');
      error.code = 'page-limit';
      throw error;
    }
    if (seen.has(path)) {
      const error = new Error('来源记录页出现循环');
      error.code = 'cursor-loop';
      throw error;
    }
    seen.add(path);

    const target = new URL(path, client.origin);
    const document = await client(path);
    const page = normalizePage(document);
    const position = sourcePosition(target);
    const pageObservations = page.records.map((record, index) =>
      normalizeObservation({...record, source:{path:target.href, index}})
    );
    pages.push({path,index:position,count:page.records.length});
    observations.push(...pageObservations);
    if (onPage) {
      const exchanges = client.drainExchanges
        ? client.drainExchanges()
        : (client.exchanges ?? []).filter(exchange => exchange.url === target.href);
      await onPage({path,index:position,observations:pageObservations,pages,exchanges});
    }
    path = page.next;
  }

  return {observations:mergeObservations(observations),pages};
}

/**
 * 兼容原有单份摘要读取；摘要不提供多处观测，只能作为一条已结束资料，
 * 缺失的启动、时间与高位信息照实留空，由派生结果标为待核对。
 */
export async function collect(client) {
  const document = await client('/accounting');
  const record = {
    ...document,
    status:document.status ?? 'Stop',
    sessionTime:document.sessionTime ?? document.duration,
    inputOctets:document.inputOctets ?? document.inputBytes,
    source:{path:new URL('/accounting', client.origin).href,index:0}
  };
  return [normalizeObservation(record)];
}
