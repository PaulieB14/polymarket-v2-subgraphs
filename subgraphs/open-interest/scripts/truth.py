# Usage: python truth.py <conditionId> <fromBlock> [atBlock]
# On-chain OI for one condition: CTF split/merge by collateral, plus NegRiskAdapter split - merge - redeem - conversions.
# Needs: pip install eth-abi eth-utils requests
from rpc import *
from eth_abi import decode
from collections import defaultdict
import sys
c=sys.argv[1]; FROM=int(sys.argv[2]); 
HEAD=int(sys.argv[3]) if len(sys.argv)>3 else int(call('eth_blockNumber',[]),16); print('HEAD',HEAD)
def logs(addr,topics,frm=FROM,to=None):
    to=HEAD if to is None else to
    try:
        return call('eth_getLogs',[{'address':addr,'topics':topics,'fromBlock':hex(frm),'toBlock':hex(to)}])
    except Exception as e:
        if 'more than' not in str(e): raise
        mid=(frm+to)//2
        return logs(addr,topics,frm,mid)+logs(addr,topics,mid+1,to)
out={}
tot=defaultdict(int)
for k in ('split','merge'):
    L=logs(CTF,[T[k],None,None,c])
    byc=defaultdict(int); n=defaultdict(int)
    for l in L:
        col,part,amt=decode(['address','uint256[]','uint256'],bytes.fromhex(l['data'][2:]))
        parent=l['topics'][2]
        key=(col,'nested' if int(parent,16) else 'root')
        byc[key]+=amt; n[key]+=1
    print('CTF',k,{f'{a}/{b}':(n[(a,b)],v/1e6) for (a,b),v in byc.items()})
for k in ('nsplit','nmerge','nredeem'):
    L=logs(NRA,[T[k],None,c])
    s=0
    for l in L:
        d=bytes.fromhex(l['data'][2:])
        if k=='nredeem': _,amt=decode(['uint256[]','uint256'],d)
        else: (amt,)=decode(['uint256'],d)
        s+=amt
    tot[k]=s
    print('NRA',k,len(L),s/1e6)
# conversions
qid=None
P=logs(CTF,[T['prep'],c],4023686)
qid=P[0]['topics'][3]; oracle=P[0]['topics'][2]
print('oracle',oracle,'questionId',qid)
if int(oracle,16)==int(NRA,16):
    mid=qid[:-2]+'00'; idx=int(qid[-2:],16)
    MP=logs(NRA,[T['nmprep'],mid],50505403)
    fee=decode(['uint256','bytes'],bytes.fromhex(MP[0]['data'][2:]))[0] if MP else 0
    QP=logs(NRA,[T['nqprep'],mid],50505403)
    qc=len(QP)
    CV=logs(NRA,[T['nconv'],None,mid],50505403)
    red=0; nconv=0
    for l in CV:
        iset=int(l['topics'][3],16); (amt,)=decode(['uint256'],bytes.fromhex(l['data'][2:]))
        if not (iset>>idx)&1: continue
        no=bin(iset & ((1<<qc)-1)).count('1')  # official counts only bits < questionCount at event time; approx
        if no>1:
            nconv+=1
            feeAmt=amt*fee//10000; a=amt-feeAmt
            red+= (feeAmt*(no-1))//no + (a*(no-1))//no
    print('market',mid,'idx',idx,'feeBips',fee,'questions',qc,'conversions touching',nconv,'OI reduction',red/1e6)
    tot['conv']=red
print('NegRisk-adapter OI = nsplit - nmerge - nredeem - conv =',(tot['nsplit']-tot['nmerge']-tot['nredeem']-tot['conv'])/1e6)
