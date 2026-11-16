# 来源资料约定

园区接入网使用资料收件器。读取本地网关的RADIUS Accounting风格字段投影，不实现真实网络认证或计费。

## 交互与身份

GET /accounting返回一份已结束摘要。GET /accounting-records?cursor=0返回records/next，每条含collector、packetIdentifier、nas、nasBoot、sessionId、port、status、sessionTime、eventTime、delayTime、inputOctets、inputGigawords及userPseudonym。status为Start/Interim-Update/Stop；packetIdentifier是可复用的传输编号，不是业务唯一键。inputOctets为32位低位，高位inputGigawords可缺席；不声明高位时不能仅凭低位倒退断定回绕次数。eventTime是源事件时间、delayTime是重发延迟；nasBoot缺失时身份可能无法确定。sessionTime是累计会话时长，Stop只关闭对应启动身份与会话。

## 收件的身份与观测

- 设备启动身份：`nas`+`nasBoot`。业务会话身份：`nas`+`nasBoot`+`sessionId`+`port`。投递身份：`collector`+`packetIdentifier`。三者分别保留，`packetIdentifier`变化不改变其所属事件。
- 同一事件按设备启动、业务会话、状态、来源事件时间、累计计数、累计时长和伪名归并；重试投递不新增事件，全部投递凭据并列保留。
- 每条观测保留原始`inputOctets`、`inputGigawords`是否出现、`sessionTime`、`eventTime`与`delayTime`，并注明来源页地址与记录位置。
- 高位与低位齐全时按`gigawords * 2^32 + octets`还原精确累计值。高位缺失、累计值倒退或累计时长倒退时不推断、不补整圈、不记负数，该段用量标为未确认。
- 缺少来源事件时间时只保留接收顺序，不据此确认用量次序；同一会话同一事件时间出现多条不同观测时同样留待核对。
- 只有同一启动身份下从Start到Stop、且各段计数与时长都能确认的会话才标记`complete`。结束记录只作用于自己的启动身份与会话，晚到的Stop不会关闭同端口重启后的新会话。

## 外部变化

正常资料在 `fixtures/source.mjs`。同一来源可能处于这些外部阶段：unknown-high。集成测试通过来源实例的`setPhase`切换外部状态，这不是线上业务接口。阶段内同一URL的响应可以改变，其余URL保留正常资料；来源的请求轨迹在实例的`requests`中可查，控制方法不对网络开放。未知地址返回404，非法请求返回非成功状态。`unknown-high`阶段只改变部分记录的高位是否出现，不改动其他来源字段。

## 收件边界

`src/reader.mjs`按cursor读取全部记录页，拒绝越界地址、页循环和超出上限的分页；每页读取后立即归档，重复领取或补件合并到已有观测，不新增重复观测。`src/archive.mjs`按摘要保存原文、按版本保存观测，打开归档时逐份校验；旧版索引可继续读取。来源文件、接收记录和对外查询不共享内存对象。未声明的协议能力不作推断；格式子集以本页和实际来源为准。
