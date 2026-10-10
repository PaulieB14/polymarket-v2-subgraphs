from rpc import *
from eth_abi import decode
B=95260000
L=call('eth_getLogs',[{'address':CTF,'topics':[T['redeem']],'fromBlock':hex(B),'toBlock':hex(B+20)}])
print('CTF PayoutRedemption topic0',T['redeem'],'| logs in blocks',B,'-',B+20,':',len(L))
picked={}
for l in L:
    col='0x'+l['topics'][2][-40:]
    cond,isets,payout=decode(['bytes32','uint256[]','uint256'],bytes.fromhex(l['data'][2:]))
    if payout==0: continue
    if col not in picked: picked[col]=l
    if len(picked)==3: break
for col,l in picked.items():
    d=bytes.fromhex(l['data'][2:]); tp=l['topics']
    cond,isets,payout=decode(['bytes32','uint256[]','uint256'],d)
    print(f"\ntx {l['transactionHash']} log {int(l['logIndex'],16)} block {int(l['blockNumber'],16)}")
    print('  FIXED ABI: redeemer=0x'+tp[1][-40:],' collateralToken='+col,' parentCollectionId='+tp[3])
    print('             conditionId=0x'+cond.hex(),' indexSets=',list(isets),' payout=',payout,f'({payout/1e6} USDC)')
    ocol='0x'+d[12:32].hex()  # old ABI: word 0 read as address (graph-node takes low 20 bytes)
    print('  OLD ABI:   collateralToken=',ocol,' parentCollectionId=',tp[2],' conditionId=',tp[3])
