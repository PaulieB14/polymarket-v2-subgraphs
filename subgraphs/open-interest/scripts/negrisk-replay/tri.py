import json,sys
def run(F,mode):
  conds=F['conds']; fee=F['fee']; ev=F['events']
  oi={c:0 for c in conds}; minted={c:0 for c in conds}; burned={c:0 for c in conds}; out={}; n=0; mn={c:0 for c in conds}; g=0
  for e in ev:
    k=e['k']
    if k=='QP': n+=1
    elif k in('SP','MG','RD'):
      d=e['amt'] if k=='SP' else -e['amt']; oi[e['c']]+=d; g+=d
    elif k=='CV':
      a=e['amt']; no=[conds[i] for i in range(n) if e['idx']>>i&1]; yes=[conds[i] for i in range(n) if not e['idx']>>i&1]; kk=len(no)
      if mode=='old':
        if kk>1:
          f=a*fee//10000; fr=f*(kk-1); ur=(a-f)*(kk-1); per=fr//kk+ur//kk
          for c in no: oi[c]-=per
          g-=fr+ur
      elif mode=='pr3':
        if kk and a:
          for c in yes: oi[c]+=a
          if kk>1: g-=a*(kk-1)
      else:
        if kk and a:
          for c in yes:
            if out.get(c)==2: continue
            oi[c]+=a; minted[c]+=a
          for c in no:
            if out.get(c)==1: continue
            oi[c]-=a; burned[c]+=a
          if kk>1: g-=a*(kk-1)
    elif k=='OR' and mode=='new':
      c=conds[int(e['q'][-2:],16)]
      if c in out: continue
      out[c]=1 if e['out'] else 2
      if e['out']: oi[c]+=burned[c]; burned[c]=0
      else: oi[c]-=minted[c]; minted[c]=0
    for c in conds: mn[c]=min(mn[c],oi[c])
  v=list(oi.values())
  return dict(neg=sum(x<0 for x in v),negsum=round(sum(x for x in v if x<0)/1e6,2),maxabs=round(max(abs(x) for x in v)/1e6,2),sum=round(sum(v)/1e6,2),glob=round(g/1e6,2),minever=round(min(mn.values())/1e6,2))
if __name__=='__main__':
  for f in sys.argv[1:]:
    F=json.load(open(f)); print(f, len(F['conds']),'q', len(F['events']),'events', 'OR', sum(e['k']=='OR' for e in F['events']))
    for m in ('old','pr3','new'): print('  ',m,run(F,m))
