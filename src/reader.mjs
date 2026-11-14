export async function collect(client) {
 const document=await client("/accounting");
 return [{id:document.nas+':'+document.nasBoot+':'+document.sessionId,...document}];
}
