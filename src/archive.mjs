import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, open} from 'node:fs/promises';
import {join} from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function mergeDeliveries(existing, incoming) {
  const merged = structuredClone(existing);
  const deliveries = [...(existing.deliveries ?? []), ...(incoming.deliveries ?? [])];
  const unique = new Map();
  for (const delivery of deliveries) {
    unique.set(JSON.stringify([delivery.collector,delivery.packetIdentifier,delivery.delayTime,delivery.eventTime]),delivery);
  }
  merged.deliveries = [...unique.values()];
  merged.deliveryIds = merged.deliveries
    .filter(delivery => delivery.collector !== null && delivery.packetIdentifier !== null)
    .map(delivery => `delivery:${delivery.collector}:${delivery.packetIdentifier}`);
  const variants = new Map();
  for (const variant of [...(existing.counterVariants ?? []), ...(incoming.counterVariants ?? [])]) {
    variants.set(JSON.stringify([variant.inputOctets,variant.inputGigawords,variant.inputGigawordsPresent,variant.sessionTime,variant.deliveryId]),variant);
  }
  merged.counterVariants = [...variants.values()];
  return merged;
}

async function replace(path, bytes) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

export async function openArchive(directory) {
  await mkdir(join(directory, 'objects'), {recursive:true});
  const indexPath = join(directory, 'index.json');
  let index = {version:2, records:[], observations:[], exchanges:[]};
  try {
    const loaded = JSON.parse(await readFile(indexPath, 'utf8'));
    if (loaded.version === 1) index = {...loaded, version:2, observations:[]};
    else index = loaded;
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (index.version !== 2 || !Array.isArray(index.records) || !Array.isArray(index.observations) || !Array.isArray(index.exchanges)) throw new Error('归档索引结构无效');
  for (const exchange of index.exchanges) {
    if (!/^[a-f0-9]{64}$/.test(exchange.hash)) throw new Error('归档摘要无效');
    const bytes = await readFile(join(directory, 'objects', exchange.hash));
    if (digest(bytes) !== exchange.hash) throw new Error('归档原文校验失败');
  }
  const storedObservations = () => index.observations.map(({revision,...observation}) => observation);
  let queue = Promise.resolve();
  return {
    records:() => structuredClone(index.records),
    observations:() => structuredClone(storedObservations()),
    exchanges:() => structuredClone(index.exchanges),
    raw: async hash => {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('原文摘要无效');
      const bytes = await readFile(join(directory, 'objects', hash));
      if (digest(bytes) !== hash) throw new Error('原文校验失败');
      return bytes;
    },
    commit(records, exchanges) {
      const operation = queue.then(async () => {
        const next = structuredClone(index);
        for (const exchange of exchanges) {
          const hash = digest(exchange.bytes);
          await replace(join(directory, 'objects', hash), exchange.bytes);
          const receiptId = digest(Buffer.from(exchange.url + ':' + exchange.status + ':' + hash));
          if (!next.exchanges.some(existing => existing.receiptId === receiptId)) {
            next.exchanges.push({receiptId,url:exchange.url,status:exchange.status,contentType:exchange.contentType,hash});
          }
        }
        for (const record of records) {
          if (typeof record.id !== 'string' || !record.id) throw new Error('资料必须有非空标识');
          const revision = digest(Buffer.from(JSON.stringify(record)));
          if (!next.records.some(existing => existing.id === record.id && existing.revision === revision)) {
            next.records.push({...record,revision});
          }
        }
        await replace(indexPath, Buffer.from(JSON.stringify(next, null, 2)));
        index = next;
        return {records:next.records.length,exchanges:next.exchanges.length};
      });
      queue = operation.catch(() => {});
      return operation;
    },
    commitObservations(observations, exchanges) {
      const operation = queue.then(async () => {
        const next = structuredClone(index);
        if (!Array.isArray(next.observations)) next.observations = [];
        for (const exchange of exchanges) {
          const hash = digest(exchange.bytes);
          await replace(join(directory, 'objects', hash), exchange.bytes);
          const receiptId = digest(Buffer.from(exchange.url + ':' + exchange.status + ':' + hash));
          if (!next.exchanges.some(existing => existing.receiptId === receiptId)) {
            next.exchanges.push({receiptId,url:exchange.url,status:exchange.status,contentType:exchange.contentType,hash});
          }
        }
        for (const observation of observations) {
          if (typeof observation.id !== 'string' || !observation.id) throw new Error('观测资料必须有非空标识');
          const existing = next.observations.find(item => item.id === observation.id ||
            (item.observationKey && item.observationKey === observation.observationKey));
          const merged = existing ? mergeDeliveries(existing, observation) : structuredClone(observation);
          const revision = digest(Buffer.from(JSON.stringify(merged)));
          if (existing) next.observations = next.observations.filter(item => item !== existing);
          next.observations.push({...merged,revision});
        }
        await replace(indexPath, Buffer.from(JSON.stringify(next, null, 2)));
        index = next;
        return {observations:next.observations.length,exchanges:next.exchanges.length};
      });
      queue = operation.catch(() => {});
      return operation;
    }
  };
}
