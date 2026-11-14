export const seed={
  "nas": "nas1",
  "nasBoot": "boot1",
  "sessionId": "s1",
  "duration": 60,
  "inputBytes": "5000"
};
export const seedPath="/accounting";
export const routes=[
  {
    "path": "/accounting-records",
    "body": {
      "records": [
        {
          "collector": "a",
          "packetIdentifier": 1,
          "nas": "nas1",
          "nasBoot": "boot1",
          "sessionId": "s1",
          "port": 3,
          "status": "Start",
          "sessionTime": 0,
          "eventTime": 10,
          "delayTime": 0,
          "inputOctets": 0,
          "inputGigawords": 0,
          "userPseudonym": "local1"
        },
        {
          "collector": "a",
          "packetIdentifier": 2,
          "nas": "nas1",
          "nasBoot": "boot1",
          "sessionId": "s1",
          "port": 3,
          "status": "Interim-Update",
          "sessionTime": 20,
          "eventTime": 30,
          "delayTime": 1,
          "inputOctets": 10,
          "inputGigawords": 1,
          "userPseudonym": "local1"
        }
      ],
      "next": "/accounting-records?cursor=1"
    },
    "method": "GET",
    "status": 200,
    "query": {
      "cursor": "0"
    },
    "headers": {}
  },
  {
    "path": "/accounting-records",
    "body": {
      "records": [
        {
          "collector": "a",
          "packetIdentifier": 3,
          "nas": "nas1",
          "nasBoot": "boot2",
          "sessionId": "s1",
          "port": 3,
          "status": "Start",
          "sessionTime": 0,
          "eventTime": 40,
          "delayTime": 0,
          "inputOctets": 0,
          "inputGigawords": 0,
          "userPseudonym": "local1"
        },
        {
          "collector": "b",
          "packetIdentifier": 88,
          "nas": "nas1",
          "nasBoot": "boot1",
          "sessionId": "s1",
          "port": 3,
          "status": "Stop",
          "sessionTime": 25,
          "eventTime": 35,
          "delayTime": 10,
          "inputOctets": 50,
          "inputGigawords": 1,
          "userPseudonym": "local1"
        }
      ],
      "next": null
    },
    "method": "GET",
    "status": 200,
    "query": {
      "cursor": "1"
    },
    "headers": {}
  }
];
export const phases={
  "unknown-high": [
    {
      "path": "/accounting-records",
      "body": {
        "records": [
          {
            "collector": "a",
            "packetIdentifier": 1,
            "nas": "nas1",
            "nasBoot": "boot1",
            "sessionId": "s1",
            "port": 3,
            "status": "Start",
            "sessionTime": 0,
            "eventTime": 10,
            "delayTime": 0,
            "inputOctets": 0,
            "inputGigawords": 0,
            "userPseudonym": "local1"
          },
          {
            "collector": "a",
            "packetIdentifier": 2,
            "nas": "nas1",
            "nasBoot": "boot1",
            "sessionId": "s1",
            "port": 3,
            "status": "Interim-Update",
            "sessionTime": 20,
            "eventTime": 30,
            "delayTime": 1,
            "inputOctets": 0,
            "userPseudonym": "local1"
          }
        ],
        "next": "/accounting-records?cursor=1"
      },
      "method": "GET",
      "status": 200,
      "query": {
        "cursor": "0"
      },
      "headers": {}
    }
  ]
};
export const portalKind="";
