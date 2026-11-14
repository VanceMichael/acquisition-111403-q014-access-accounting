# 来源资料约定

园区接入网使用资料收件器。当前读取已整理的会话摘要；本地网关提供RADIUS Accounting风格字段投影，不实现真实网络认证或计费。

## 交互与身份

GET /accounting返回一份已结束摘要。GET /accounting-records?cursor=0返回records/next，每条含collector、packetIdentifier、nas、nasBoot、sessionId、port、status、sessionTime、eventTime、delayTime、inputOctets、inputGigawords及userPseudonym。status为Start/Interim-Update/Stop；packetIdentifier是可复用的传输编号，不是业务唯一键。inputOctets为32位低位，高位inputGigawords可缺席；不声明高位时不能仅凭低位倒退断定回绕次数。eventTime是源事件时间、delayTime是重发延迟；nasBoot缺失时身份可能无法确定。sessionTime是累计会话时长，Stop只关闭对应启动身份与会话。

## 外部变化

正常资料在 `fixtures/source.mjs`。同一来源可能处于这些外部阶段：unknown-high。集成测试通过来源实例的`setPhase`切换外部状态，这不是线上业务接口。阶段内同一URL的响应可以改变，其余URL保留正常资料；来源的请求轨迹在实例的`requests`中可查，控制方法不对网络开放。未知地址返回404，非法请求返回非成功状态。

## 已有收件边界

当前`src/reader.mjs`只收取/accounting提供的已整理资料。归档按资料标识和内容摘要区分版本，原文按响应字节摘要独立存储，打开归档时逐份校验。来源文件、接收记录和对外查询不共享内存对象。未声明的协议能力不作推断；格式子集以本页和实际来源为准。
