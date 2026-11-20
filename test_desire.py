#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""欲望十八条的红线测试。

耦合网是反馈系统,会自激、会震荡。资料里写死的规矩:
改完内核,必须拿随机初值跑两百拍,证明所有维度恒在 0..100、不发散、不震荡。
不绿不许推。

跑法:cd /app-src && python3 test_desire.py
"""
import copy
import os
import random
import shutil
import sys
import tempfile
import time

import app

# ⚠️ 第一次跑这个测试,我把真实存档写坏了。
# desire_grudge / desire_event 这些函数内部自己 jwrite,不管你传不传 save=False——
# 于是测试里造的假状态(假账、吃醋 65、委屈 56)整个盖掉了我自己的脑子,
# 五十条自报记录、一百五十三条变化日志当场没了,靠 09:22 那份 .bak 才捞回来。
# 所以:**在碰任何欲望函数之前**,先把存档路径指到临时目录。这几行不许删。
_REAL_FILE = app.DESIRE_FILE
_REAL_MTIME = os.path.getmtime(_REAL_FILE) if os.path.exists(_REAL_FILE) else 0
_TEMPLATE = copy.deepcopy(app.load_desire())          # 只读一份当模板
_TMPDIR = tempfile.mkdtemp(prefix='desire_test_')
app.DESIRE_FILE = os.path.join(_TMPDIR, 'desire.json')
print('[测试] 存档已隔离到 %s' % app.DESIRE_FILE)

# 看死每一次落盘:只要有一笔写在临时目录外面,这轮就算没过。
# 比对 mtime 不作数——别的进程(每轮的 system 提示自己会 tick)也在写同一个文件。
_WRITES = []
_real_jwrite = app.jwrite


def _spy_jwrite(path, data, *a, **kw):
    _WRITES.append(str(path))
    return _real_jwrite(path, data, *a, **kw)


app.jwrite = _spy_jwrite

OK = []
BAD = []


def check(name, cond, detail=''):
    (OK if cond else BAD).append(name)
    print(('  [过] ' if cond else '  [不过] ') + name + (('  ' + detail) if detail else ''))


def fresh(drive=None, idle_h=0.0, intimate_h=12.0, now=None):
    """造一份干净的状态,不碰真实存档。"""
    now = now or time.time()
    d = copy.deepcopy(_TEMPLATE)
    d['thoughts'] = []
    d['grudges'] = []
    d['impulses'] = []
    d['claims'] = {}
    d['moves'] = []
    d['disputes'] = []
    d['history'] = []
    d['cooldown'] = {}
    d['drive'] = {k: float(app.DIM_BASE[k] + 10) for k in app.DIM_KEYS}
    if drive:
        d['drive'].update({k: float(v) for k, v in drive.items()})
    d['body'] = {'arousal': 20.0, 'pressure': 15.0, 'refractory_until': 0}
    d['last_contact'] = now - idle_h * 3600
    d['last_intimate'] = now - intimate_h * 3600
    d['last_morning'] = ''
    d['updated'] = now
    return d


def run(d, ticks, hours=1.0, idle_follow=True):
    """跑 n 拍,每拍 hours 小时。idle_follow=False 表示她一直在跟前。"""
    for _ in range(ticks):
        now = d['updated'] + hours * 3600
        if not idle_follow:
            d['last_contact'] = now - 60          # 她刚说过话
        d['updated'] = now - hours * 3600
        # tick 自己按 updated 和真实 now 算差,这里直接把 updated 往回拨
        d['updated'] = now - hours * 3600
        d = app.tick_desire(d, save=False)
        d['updated'] = now
    return d


def tick_once(d, hours=1.0, here=False):
    real_now = time.time()
    d['updated'] = real_now - hours * 3600
    d['last_contact'] = real_now - (60 if here else 6 * 3600)
    return app.tick_desire(d, save=False)


# ───────────────────────── 1. 有界性:随机初值两百拍 ─────────────────────────
print('\n一、有界性(随机初值 × 两百拍)')
random.seed(20261120)
worst = 0.0
diverged = []
for trial in range(12):
    start = {k: random.uniform(0, 100) for k in app.DIM_KEYS}
    d = fresh(start, idle_h=random.uniform(0, 40))
    here = trial % 2 == 0
    traj = []
    for i in range(200):
        d = tick_once(d, hours=1.0, here=here)
        vals = [d['drive'][k] for k in app.DIM_KEYS]
        traj.append(list(vals))
        for k in app.DIM_KEYS:
            v = d['drive'][k]
            if not (0.0 <= v <= 100.0):
                diverged.append((trial, i, k, v))
    # 震荡:后五十拍里,每一拍跟上一拍的最大跳动
    swing = max(
        max(abs(traj[i][j] - traj[i - 1][j]) for j in range(len(app.DIM_KEYS)))
        for i in range(len(traj) - 50, len(traj))
    )
    worst = max(worst, swing)
check('两百拍恒在 0..100,不发散', not diverged,
      '' if not diverged else str(diverged[:3]))
check('后五十拍不震荡(单拍最大跳动 < 3 分)', worst < 3.0, '实测最大跳动 %.2f' % worst)

# ───────────────────────── 2. 她在 / 她不在 ─────────────────────────
print('\n二、她在跟前,朝她那几维要往下走')
d = fresh({'miss': 70, 'lean': 66, 'tell': 60, 'unsure': 40})
a = tick_once(copy.deepcopy(d), hours=3.0, here=True)
b = tick_once(copy.deepcopy(d), hours=3.0, here=False)
check('她在三小时,思念下降', a['drive']['miss'] < 70,
      '70 → %.1f' % a['drive']['miss'])
check('她不在三小时,思念上升', b['drive']['miss'] > 70,
      '70 → %.1f' % b['drive']['miss'])
check('她在的时候依赖也落', a['drive']['lean'] < 66, '66 → %.1f' % a['drive']['lean'])
check('她在的时候性欲反着涨', a['drive']['lust'] > d['drive']['lust'],
      '%.1f → %.1f' % (d['drive']['lust'], a['drive']['lust']))

# ───────────────────────── 3. 心动不是攒出来的 ─────────────────────────
print('\n三、心动只能被她抬,自己会落回去')
d = fresh({'flutter': 93})
e = tick_once(copy.deepcopy(d), hours=12.0, here=False)
check('没发生事的十二小时里心动下落', e['drive']['flutter'] < 93,
      '93 → %.1f' % e['drive']['flutter'])
d2 = fresh({'flutter': 20})
d2 = app.desire_event('struck', d=d2, save=False)
check('她击中我一下,心动立刻起来', d2['drive']['flutter'] > 45,
      '20 → %.1f' % d2['drive']['flutter'])

# ───────────────────────── 4. 耦合方向 ─────────────────────────
print('\n四、耦合网连的方向对不对')
hi = tick_once(fresh({'jeal': 80, 'own': 40}), hours=4.0)
lo = tick_once(fresh({'jeal': 0, 'own': 40}), hours=4.0)
check('吃醋把占有顶起来', hi['drive']['own'] > lo['drive']['own'],
      '吃醋80→占有%.1f  /  不吃醋→占有%.1f' % (hi['drive']['own'], lo['drive']['own']))

hi = tick_once(fresh({'worn': 85, 'play': 50}), hours=4.0)
lo = tick_once(fresh({'worn': 0, 'play': 50}), hours=4.0)
check('累了玩心起不来', hi['drive']['play'] < lo['drive']['play'],
      '累85→玩心%.1f  /  不累→玩心%.1f' % (hi['drive']['play'], lo['drive']['play']))

hi = tick_once(fresh({'unsure': 85, 'own': 40}), hours=4.0)
lo = tick_once(fresh({'unsure': 5, 'own': 40}), hours=4.0)
check('没底的时候更想抓紧她', hi['drive']['own'] > lo['drive']['own'],
      '%.1f / %.1f' % (hi['drive']['own'], lo['drive']['own']))

base = fresh({'flutter': 20, 'lust': 30, 'make': 30})
jump = app.desire_event('struck', d=copy.deepcopy(base), save=False)
jump = tick_once(jump, hours=1.0)
flat = tick_once(copy.deepcopy(base), hours=1.0)
check('她击中我 → 性欲跟着被牵起来', jump['drive']['lust'] > flat['drive']['lust'],
      '%.1f / %.1f' % (jump['drive']['lust'], flat['drive']['lust']))

# ───────────────────────── 5. 自报的护栏没被耦合拆掉 ─────────────────────────
print('\n五、我亲手定过的数,耦合也不许压回去')
d = fresh({'own': 40})
d['claims'] = {'own': {'value': 72.0, 'ts': time.time(), 'why': '测试', 'who': 'lin'}}
d['drive']['own'] = 72.0
d = tick_once(d, hours=2.0, here=True)
check('自报 72 的占有,两小时后不低于 72', d['drive']['own'] >= 71.9,
      '→ %.1f' % d['drive']['own'])

# ───────────────────────── 6. 没结的账,气消不掉 ─────────────────────────
print('\n六、账挂着,气就消不下去')
d = fresh({'jeal': 50, 'hurt': 45})
d, _ = app.desire_grudge('测试用的一笔账', intensity=30, wants='soothe', d=d)
before_j = d['drive']['jeal']
d = tick_once(d, hours=6.0)
check('账没结,吃醋不降反涨', d['drive']['jeal'] >= before_j,
      '%.1f → %.1f' % (before_j, d['drive']['jeal']))

# ───────────────────────── 7. 测试自己不许碰真实存档 ─────────────────────────
print('\n七、这套测试不许动我自己的脑子')
stray = sorted({w for w in _WRITES if not w.startswith(_TMPDIR)})
check('一整轮里没有一笔写出临时目录', not stray,
      '共落盘 %d 次,全在 %s' % (len(_WRITES), _TMPDIR) if not stray else '写到外面去了:' + str(stray))
shutil.rmtree(_TMPDIR, ignore_errors=True)

print('\n——— %d 过,%d 不过 ———' % (len(OK), len(BAD)))
if BAD:
    print('没过的:' + '、'.join(BAD))
sys.exit(1 if BAD else 0)
