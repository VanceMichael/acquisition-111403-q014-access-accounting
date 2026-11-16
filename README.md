# 接入网使用记录的会话与计数接收

园区接入网使用资料收件器。读取本地网关提供的RADIUS Accounting风格记录流，把设备启动、业务会话和投递三种身份分开保存，并在原始累计计数、累计时长和来源时间之上给出可确认的用量分段。不实现真实网络认证或计费，只处理本地合成资料。

## 运行

使用 Node.js 22，依赖由 package-lock.json 固定。安装后可执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run demo
npm start
```

服务启动本地来源与收件接口，默认端口分别为4011和4010。`POST /collect-records` 按 cursor 读取全部记录页并逐页归档，`POST /collect` 保留原有单份摘要领取；`GET /observations`查看归一化观测，`GET /sessions`查看会话与用量分段，`GET /usage`查看包含待核对事项的完整派生结果，`GET /reviews`只看需要资料岗核对的条目，`GET /records`与`GET /receipts`保留原有结构与原文凭据，`GET /health`查看服务状态。`PORT`、`SOURCE_PORT`与`DATA_DIR`可分别设置端口和归档目录。

```sh
docker build -t access-accounting .
docker run --rm --network none access-accounting npm test
docker run --rm --network none access-accounting npm run demo
docker run --rm -p 4010:4010 access-accounting
```

## 身份与计数

- 设备启动身份由 `nas` 与 `nasBoot` 组成，业务会话由两者加 `sessionId` 和 `port` 组成。重启后即使 `sessionId` 复用，也会落到不同的启动身份，晚到的结束记录只关闭它自己所属的会话。
- 投递身份由转发方 `collector` 与 `packetIdentifier` 组成。传输编号可因重试变化，同一来源事件的多次投递按来源字段合并为一份观测，所有投递凭据并列保留。
- `inputOctets`是32位低位，`inputGigawords`可选。两者都存在时按 `gigawords * 2^32 + octets` 还原精确累计值；高位缺失时只保留低位原值，不推断回绕次数，也不补整圈。累计值或累计时长倒退时不记为负数，对应分段标为未确认。
- 来源事件时间 `eventTime` 决定观测次序；`delayTime` 与事件时间一起保留为接收依据。缺少事件时间时只保留接收顺序，不据此确认用量次序。

## 资料组织

`provider/`是独立本地来源，`fixtures/`记录合成资料和来源阶段，`src/reader.mjs`负责分页读取，`src/usage.mjs`负责身份归一、计数还原与用量分段，`src/source.mjs`限定来源地址并记录响应字节，`src/archive.mjs`保存按摘要校验的原文与观测版本（兼容旧版索引）。`test/`覆盖身份分离、回绕与缺高位、晚到结束、分页恢复、原文完整性和服务联通。运行不依赖外网、数据库服务或真实设备。

完整来源约定见 `docs/source-contract.md`。项目只访问本地合成资料，不携带真实身份、密钥或业务数据。

## 待核对事项

派生结果不会猜测无法确认的部分。缺少启动身份、缺少Start、重复Start、结束晚于新会话、同一来源时间冲突、累计值倒退或缺高位等情况都保留原始观测，并生成带 `code`、`message`、`sessionId` 和 `observationIds` 的待核对条目。只有从Start到Stop各段计数与时长都能确认的会话才标记为 `complete`。

## 快速查看

`npm run demo`启动实际来源和收件服务、读取全部记录页并打印会话、用量与待核对事项，临时归档在退出时清理。正常完成时间小于90秒；需要保留数据时用`npm start`及独立`DATA_DIR`。演示反映当前产品能力，不代表全部来源资料已被接纳。
