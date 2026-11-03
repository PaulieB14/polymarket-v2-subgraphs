exec(open(__import__('os').path.join(__import__('os').path.dirname(__file__),'rl.py')).read())
import json,sys
M=sys.argv[1]; A=int(sys.argv[2]); B=int(sys.argv[3])
def pad(x): return '0x'+x[2:].rjust(64,'0')
T=dict(MP=t('MarketPrepared(bytes32,address,uint256,bytes)'),QP=t('QuestionPrepared(bytes32,bytes32,uint256,bytes)'),CV=t('PositionsConverted(address,bytes32,uint256,uint256)'),SP=t('PositionSplit(address,bytes32,uint256)'),MG=t('PositionsMerge(address,bytes32,uint256)'),RD=t('PayoutRedemption(address,bytes32,uint256[],uint256)'),OR=t('OutcomeReported(bytes32,bytes32,bool)'))
inv={v:k for k,v in T.items()}
out=[]
def scan(topics):
  for a in range(A,B,1000000):
    out.extend(logs(a,min(a+999999,B),topics))
scan([[T['MP'],T['QP']],M]); qs=[l for l in out if l['topics'][0]==T['QP']]
fee=[int(l['data'][2:66],16) for l in out if l['topics'][0]==T['MP']]
def cid(q):
  return '0x'+keccak.new(digest_bits=256,data=bytes.fromhex(NRA[2:].lower())+bytes.fromhex(q[2:])+(2).to_bytes(32,'big')).hexdigest()
conds=[cid(l['topics'][2]) for l in sorted(qs,key=lambda l:int(l['data'][2:66],16))]
print("questions",len(conds),"fee",fee,file=sys.stderr)
scan([T['CV'],None,M])
scan([T['OR'],M])
scan([[T['SP'],T['MG'],T['RD']],None,conds])
ev=[]
for l in out:
  k=inv[l['topics'][0]]; d=l['data'][2:]
  e=dict(k=k,b=int(l['blockNumber'],16),li=int(l['logIndex'],16))
  if k=='CV': e.update(idx=int(l['topics'][3],16),amt=int(d[:64],16))
  elif k in('SP','MG'): e.update(c=l['topics'][2],amt=int(d[:64],16))
  elif k=='RD': e.update(c=l['topics'][2],amt=int(d[64:128],16))
  elif k=='QP': e.update(q=l['topics'][2])
  elif k=='OR': e.update(q=l['topics'][2],out=int(d[:64],16))
  ev.append(e)
ev.sort(key=lambda e:(e['b'],e['li']))
json.dump(dict(market=M,fee=fee[0] if fee else 0,conds=conds,events=ev),open('fixture-%s.json'%M[-6:],'w'))
from collections import Counter; print(Counter(e['k'] for e in ev),file=sys.stderr)
