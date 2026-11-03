import json,urllib.request,time,sys
from Crypto.Hash import keccak
t=lambda s:'0x'+keccak.new(digest_bits=256,data=s.encode()).hexdigest()
U="https://polygon.rpc.service.pinax.network"; NRA="0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"
def _one(a,b,topics):
  r=json.load(urllib.request.urlopen(urllib.request.Request(U,json.dumps({"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":hex(a),"toBlock":hex(b),"address":NRA,"topics":topics}]}).encode(),{"content-type":"application/json"}),timeout=60))
  if "result" in r: return r["result"]
  raise Exception(str(r.get("error")))
def logs(a,b,topics,depth=0):
  for i in range(4):
    try: return _one(a,b,topics)
    except Exception as e:
      msg=str(e)
      if 'rate' in msg.lower() or '429' in msg: time.sleep(2+i); continue
      break
  if b-a<1000: 
    time.sleep(3); return _one(a,b,topics)
  m=(a+b)//2
  return logs(a,m,topics,depth+1)+logs(m+1,b,topics,depth+1)
