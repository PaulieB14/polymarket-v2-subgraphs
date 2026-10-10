import requests, json, time
from eth_utils import keccak
R="https://polygon.gateway.tenderly.co"
def call(m,p):
    for i in range(5):
        try:
            r=requests.post(R,json={"jsonrpc":"2.0","id":1,"method":m,"params":p},timeout=60).json()
            if 'error' in r: raise Exception(r['error'])
            return r['result']
        except Exception as e:
            err=e; time.sleep(1+i)
    raise err
def t(sig): return '0x'+keccak(text=sig).hex()
CTF="0x4D97DCd97eC945f40cF65F87097ACe5EA0476045".lower()
NRA="0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296".lower()
T=dict(
 split=t("PositionSplit(address,address,bytes32,bytes32,uint256[],uint256)"),
 merge=t("PositionsMerge(address,address,bytes32,bytes32,uint256[],uint256)"),
 redeem=t("PayoutRedemption(address,address,bytes32,bytes32,uint256[],uint256)"),
 prep=t("ConditionPreparation(bytes32,address,bytes32,uint256)"),
 nsplit=t("PositionSplit(address,bytes32,uint256)"),
 nmerge=t("PositionsMerge(address,bytes32,uint256)"),
 nredeem=t("PayoutRedemption(address,bytes32,uint256[],uint256)"),
 nconv=t("PositionsConverted(address,bytes32,uint256,uint256)"),
 nqprep=t("QuestionPrepared(bytes32,bytes32,uint256,bytes)"),
 nmprep=t("MarketPrepared(bytes32,address,uint256,bytes)"),
)
