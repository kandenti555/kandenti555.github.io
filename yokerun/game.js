
      "use strict";
      /* ================= SAVE (localStorage + in-memory fallback) ================= */
      var SAVE_KEY = "niamisu60_save_v1";
      function defaultSave(){
        return {
          best: 0, coins: 20, level: 1, xp: 0, plays: 0,
          streak: 1, lastDay: "",
          skin: "normal",
          owned: { phantom:false, comet:false, inferno:false, mint:false, grape:false, sakura:false },
          upg: { magnet:0, shield:0, mult:0 },
          pass: false,
          totNear: 0, totStars: 0, totGold: 0,
          missionSet: 0, mBase: { near:0, stars:0, gold:0 },
          bestRevived: false,
          lives: 5, livesTs: 0,
          status: { speed:0, magnet:0, luck:0, shield:0, score:0 },
          settings: { sound:true, crt:true, vib:true, bgm:"pop", public:true },
          itemStock: { attack:0, shield:0, magnet:0, x2:0 },
          friend: { sentDate:"", sent:{}, inbox:[{ id:"seed1", from:"mochi" }, { id:"seed2", from:"puni" }], pending:false, reqCount:0, flives:{ puni:3, mochi:2, dot:4, yuru:1 } },
          ranked: { rating:0, best:0, plays:0, lastDelta:0, lastNote:"まだランク戦を遊んでいません", seasonPass:false },
          naviSeen: false,
          navi: { outfit:"base", hair:"bob", owned:{ base:true } },
          legend: { fragments:0, cycle:-1, owned:{}, justUnlocked:false },
          difficulty: "normal",
          daily: { key:"", ids:[], challengeId:"", counters:{ runs:0, stars:0, near:0, gold:0, score:0, bestScore:0, maxCombo:0, clutchNear:0, attacks:0, fragments:0 }, done:{}, challengeDone:false, earned:0 },
          weekly: { key:"", ids:[], counters:{ runs:0, stars:0, near:0, gold:0, score:0, bestScore:0, maxCombo:0, clutchNear:0, attacks:0, fragments:0 }, done:{}, earned:0 },
          totMaxCombo: 0,
          endless: { bestTime:0, bestScore:0, coins:0, items:{ comet:false, sparkle:false, outfit:false }, outfitOn:false },
          trails: { sakura:false, season:false, sparkle:false, equip:"none" },
          stats: { runs:[], totalRuns:0, totalCoinsEarned:0, totalCoinsSpent:0, resultsShown:0, restarts:0, firstDay:"", days:{}, coinsSinceOutfit:0, runsSinceOutfit:0, lastScore:{ casual:-1, endless:-1, ranked:-1 }, galsUsed:{}, lastRunDate:"", firstClear:false },
          season: { key:"", points:0, paid:false, granted:0, paidGranted:0, maxTier:0 },
          album: {}
        };
      }
      var save = (function(){
        var s = defaultSave();
        try {
          var raw = localStorage.getItem(SAVE_KEY);
          if (raw){
            var p = JSON.parse(raw);
            for (var k in s){
              if (p[k] !== undefined){
                if (typeof s[k] === "object" && s[k] !== null && !Array.isArray(s[k])){
                  for (var k2 in s[k]) if (p[k] && p[k][k2] !== undefined) s[k][k2] = p[k][k2];
                } else s[k] = p[k];
              }
            }
            // dynamic-key stores the generic one-level merge cannot carry:
            // album cards are keyed by card id, navi keeps char / variant state
            if (p.album) s.album = p.album;
            if (p.navi){
              if (p.navi.char) s.navi.char = p.navi.char;
              if (p.navi.chars) s.navi.chars = p.navi.chars;
              if (p.navi.variant !== undefined) s.navi.variant = p.navi.variant;
              if (p.navi.variantOwned) s.navi.variantOwned = p.navi.variantOwned;
            }
          }
        } catch(e){}
        return s;
      })();
      function persist(){ try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch(e){} }
      /* ---- こうかい版モード (public / free-release mode): a display-and-rules
         switch only. When ON: lives are never consumed, every ¥-priced mock
         purchase surface is hidden, the friend page is unreachable, and the
         ranked page labels other players' records as samples. When OFF the
         game behaves exactly as before. No prices, caps or odds change. ---- */
      function publicMode(){ return !!(save.settings && save.settings.public); }
      // streak: consecutive days played
      (function(){
        function dayStr(d){ return d.getFullYear() + "-" + (d.getMonth()+1) + "-" + d.getDate(); }
        var today = dayStr(new Date());
        var y = new Date(); y.setDate(y.getDate() - 1);
        var yest = dayStr(y);
        if (save.lastDay !== today){
          save.streak = (save.lastDay === yest) ? save.streak + 1 : 1;
          save.lastDay = today;
          persist();
        }
      })();
      var revivesUsed = 0;
      var missionJustUp = false;
      /* ---- ATTACK: 1 free per run, coin buys raise the per-run total to a hard cap of 3 ---- */
      var ATTACK_MAX = 3;
      var ATTACK_COSTS = [100, 200];   // 1st extra +100 coins, 2nd extra +200 coins
      var preAttacks = 0;               // extras bought on the home screen for the next run
      function attackCost(boughtCount){ return boughtCount >= 0 && boughtCount < ATTACK_COSTS.length ? ATTACK_COSTS[boughtCount] : null; }

      /* ================= PROGRESSION ================= */
      function xpNeed(){ return save.level * 100; }              // XP to next level
      /* missions: completing a set of 3 raises the permanent score multiplier by +1 (cap x10) — Subway Surfers pattern, prototype-scoped */
      function missionMult(){ return 1 + Math.min(save.missionSet, 9); }
      function reviveCost(){ return revivesUsed === 0 ? 150 : 300; }

      /* ================= DIFFICULTY / WEEKLY MODIFIER / DAILY-WEEKLY MISSIONS =================
         Score-MAX invariant (casual): difficulty changes ONLY obstacle speed, gap width,
         obstacle movement and spawn density feel. Fixed across all difficulties:
         star total (40) + gold total (4), gate/corridor sections (4), every bonus point
         value, 60s run time, last-10s x2. No per-difficulty score multiplier.
         THEORETICAL MAX (at multiplier x1) = time 840 + (stars 2000 + gold 2000 +
         gates 300 + corridor 1200) x 2.0 (perfect-play combo factor) = 11,840. */
      var STAR_TOTAL = 40, GOLD_TOTAL = 4;
      var SCORE_MAX_BASE = 11840;
      var DIFFS = {
        easy:   { label:"やさしい",   speed:0.82, gateBonus:34,  wallGap:118, corrHalf:74, spawnMul:1.28, driftMul:0.45, driftPhase:3 },
        normal: { label:"ふつう",     speed:1.00, gateBonus:0,   wallGap:88,  corrHalf:62, spawnMul:1.00, driftMul:1.00, driftPhase:2 },
        hard:   { label:"むずかしい", speed:1.16, gateBonus:-24, wallGap:78,  corrHalf:54, spawnMul:0.84, driftMul:1.50, driftPhase:2 }
      };
      var MODIFIERS = [
        { id:"gold",     ic:"⭐", name:"金星ラッシュの週",       desc:"金星が 早めに・まとまって 出る（ぜんぶで 4個は 同じ）。" },
        { id:"near",     ic:"💨", name:"ニアミスボーナスの週",   desc:"コンボが つづく時間が 2.6秒→3.6秒に。点数は 同じ。" },
        { id:"magnet",   ic:"🧲", name:"マグネット多めの週",     desc:"マグネットが 出やすく、きく時間が 5秒→7秒に。" },
        { id:"shield",   ic:"🛡️", name:"シールド多めの週",       desc:"シールドが 出やすく、はじめの シールド +1。" },
        { id:"starrain", ic:"🌟", name:"スターの雨多めの週",     desc:"スターの雨が 出やすくなる（星の 数は 同じ）。" },
        { id:"x2",       ic:"✖️", name:"×2チャンスの週",         desc:"スコア×2 アイテムが 出やすくなる。" }
      ];
      var DAILY_COIN_CAP = 150, WEEKLY_COIN_CAP = 300;
      var DAILY_POOL = [
        { id:"d_runs3",    label:"3回 走る",               key:"runs",      target:3,    reward:20 },
        { id:"d_stars30",  label:"星を 30個 あつめる",       key:"stars",     target:30,   reward:20 },
        { id:"d_near15",   label:"ニアミス 15回",           key:"near",      target:15,   reward:25 },
        { id:"d_gold2",    label:"金星を 2個 あつめる",       key:"gold",      target:2,    reward:25 },
        { id:"d_score3000",label:"1回で スコア 3,000",      key:"bestScore", target:3000, reward:30 },
        { id:"d_combo8",   label:"8コンボに とどく",         key:"maxCombo",  target:8,    reward:20 },
        { id:"d_clutch3",  label:"クラッチで ニアミス 3回",   key:"clutchNear",target:3,    reward:25 },
        { id:"d_attack2",  label:"攻撃を 2回 つかう",         key:"attacks",   target:2,    reward:15 }
      ];
      var CHALLENGE_POOL = [
        { id:"c_score4500", label:"きょうの チャレンジ： 1回で スコア 4,500", key:"bestScore", target:4500, reward:50 },
        { id:"c_near25",    label:"きょうの チャレンジ： ニアミス ぜんぶで 25回", key:"near",      target:25,   reward:40 },
        { id:"c_gold3",     label:"きょうの チャレンジ： 金星を 3個 あつめる",   key:"gold",      target:3,    reward:50 },
        { id:"c_stars60",   label:"きょうの チャレンジ： 星を 60個 あつめる",   key:"stars",     target:60,   reward:40 },
        { id:"c_combo12",   label:"きょうの チャレンジ： 12コンボに とどく",   key:"maxCombo",  target:12,   reward:40 }
      ];
      var WEEKLY_POOL = [
        { id:"w_runs15",   label:"15回 走る",             key:"runs",      target:15,    reward:80 },
        { id:"w_stars200", label:"星を 200個 あつめる",     key:"stars",     target:200,   reward:80 },
        { id:"w_near80",   label:"ニアミス 80回",         key:"near",      target:80,    reward:100 },
        { id:"w_gold8",    label:"金星を 8個 あつめる",     key:"gold",      target:8,     reward:100 },
        { id:"w_score30000",label:"スコア ぜんぶで 30,000", key:"score",     target:30000, reward:90 },
        { id:"w_frag2",    label:"伝説のカケラを 2個 ひろう", key:"fragments", target:2,     reward:60 },
        { id:"w_best6000", label:"1回で スコア 6,000",     key:"bestScore", target:6000,  reward:90 }
      ];
      function dateKey(d){ return d.getFullYear() + "-" + (d.getMonth()+1) + "-" + d.getDate(); }
      function hashStr(s){ var h = 2166136261; for (var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
      function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
      function rnd(){ return G && G.rng ? G.rng() : Math.random(); }
      function comboTime(){ return G && G.modifier === "near" ? 3.6 : 2.6; }
      function pickIds(pool, seed, n){
        var r = mulberry32(seed), idx = pool.map(function(_, i){ return i; });
        for (var i = idx.length - 1; i > 0; i--){ var j = (r() * (i + 1)) | 0, t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
        return idx.slice(0, n).map(function(i){ return pool[i].id; });
      }
      function mondayOf(d){ var x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); var dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); return x; }
      function weekKeyStr(){ return dateKey(mondayOf(new Date())); }
      function weekIndex(){ return Math.floor(mondayOf(new Date()).getTime() / 604800000); }
      function currentModifier(){ var len = MODIFIERS.length; var i = ((weekIndex() % len) + len) % len; return MODIFIERS[i]; }
      function defById(pool, id){ for (var i = 0; i < pool.length; i++) if (pool[i].id === id) return pool[i]; return null; }
      function zeroCounters(){ return { runs:0, stars:0, near:0, gold:0, score:0, bestScore:0, maxCombo:0, clutchNear:0, attacks:0, fragments:0 }; }
      function ensurePeriods(){
        var changed = false, today = dateKey(new Date()), wk = weekKeyStr();
        if (!save.daily || save.daily.key !== today){
          save.daily = { key: today, ids: pickIds(DAILY_POOL, hashStr("d" + today), 3), challengeId: pickIds(CHALLENGE_POOL, hashStr("c" + today), 1)[0], counters: zeroCounters(), done: {}, challengeDone: false, earned: 0 };
          changed = true;
        }
        if (!save.weekly || save.weekly.key !== wk){
          save.weekly = { key: wk, ids: pickIds(WEEKLY_POOL, hashStr("w" + wk), 3), counters: zeroCounters(), done: {}, earned: 0 };
          changed = true;
        }
        if (changed) persist();
        return changed;
      }
      function addRunToPeriods(s){
        ensurePeriods();
        [save.daily, save.weekly].forEach(function(P){
          var c = P.counters;
          c.runs += 1; c.stars += s.stars; c.near += s.near; c.gold += s.gold; c.score += s.score;
          c.clutchNear += s.clutchNear; c.attacks += s.attacks; c.fragments += s.fragments;
          if (s.score > c.bestScore) c.bestScore = s.score;
          if (s.maxCombo > c.maxCombo) c.maxCombo = s.maxCombo;
        });
      }
      function checkAllCompletions(){
        var wins = [];
        function grant(P, cap, def, kind){
          var g = Math.min(def.reward, Math.max(0, cap - P.earned));
          P.earned += g; save.coins += g;
          wins.push({ label: def.label, reward: g, capHit: g < def.reward, kind: kind || "mission" });
        }
        var d = save.daily, ch = defById(CHALLENGE_POOL, d.challengeId);
        if (ch && !d.challengeDone && (d.counters[ch.key] || 0) >= ch.target){ d.challengeDone = true; grant(d, DAILY_COIN_CAP, ch, "challenge"); }
        d.ids.forEach(function(id){ var def = defById(DAILY_POOL, id); if (def && !d.done[id] && (d.counters[def.key] || 0) >= def.target){ d.done[id] = true; grant(d, DAILY_COIN_CAP, def); } });
        var w = save.weekly;
        w.ids.forEach(function(id){ var def = defById(WEEKLY_POOL, id); if (def && !w.done[id] && (w.counters[def.key] || 0) >= def.target){ w.done[id] = true; grant(w, WEEKLY_COIN_CAP, def); } });
        return wins;
      }
      function diffOf(){ return DIFFS[save.difficulty] ? save.difficulty : "normal"; }
      function renderPreRun(){
        var cur = diffOf();
        Array.prototype.forEach.call(document.querySelectorAll("[data-diff]"), function(b){
          var on = b.getAttribute("data-diff") === cur;
          b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        var mod = currentModifier();
        var ml = $("home-mod-line"); if (ml) ml.innerHTML = "今週のボーナス： " + mod.ic + " <b>" + mod.name + "</b>";
        var skEl = $("preplay-skill");
        if (skEl){ var skc = naviChar(); skEl.innerHTML = skc.skillIc + " " + skc.skillLine + "（" + skc.name + "）" + ' <span class="ps-note">ランク戦では つかえない</span>'; }
        var pm = $("preplay-music"); if (pm) pm.textContent = "おんがく： " + bgmName();
        var sm = $("home-diff-summary"); if (sm) sm.textContent = "いまの レベル： " + DIFFS[cur].label + " ／ MAX " + SCORE_MAX_BASE.toLocaleString() + " pt（どのレベルも 同じ）";
        renderModeSel();
      }
      /* pre-play mode choice: normal 60s vs endless (endless lives ONLY in
         this popup — the title screen stays title / character / Start / Menu) */
      var preplayMode = "normal";
      function renderModeSel(){
        Array.prototype.forEach.call(document.querySelectorAll("[data-mode-sel]"), function(b){
          var on = b.getAttribute("data-mode-sel") === preplayMode;
          b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        var note = $("preplay-endless-note"); if (note) note.hidden = preplayMode !== "endless";
        var sb = $("btn-preplay-start"); if (sb) sb.textContent = preplayMode === "endless" ? "▶ エンドレス開始" : "▶ プレイ スタート";
        if (preplayMode === "endless"){
          var ml = $("home-mod-line");
          if (ml) ml.innerHTML = "今週のボーナス： エンドレスには つかないよ（いつも 同じ ルール）";
        }
      }
      function dmRowHtml(label, prog, target, done, reward, tag){
        var pct = Math.min(100, Math.floor(prog / target * 100));
        return '<div class="dm-row"><div class="dm-top"><span>' + tag + " " + label + '</span><span class="' + (done ? "dm-done" : "num") + '">' + (done ? "クリア！ 🪙 +" + reward : prog.toLocaleString() + " / " + target.toLocaleString()) + '</span></div><div class="dm-bar"><div class="dm-fill" style="width:' + pct + '%"></div></div></div>';
      }
      function renderDaily(){
        var el = $("daily-page"); if (!el) return;
        ensurePeriods();
        var d = save.daily, w = save.weekly;
        var html = '<div class="dm-head"><h3>🎯 きょうの チャレンジと ミッション</h3><span class="dm-cap">きょうの ごほうび 🪙 ' + d.earned + " / " + DAILY_COIN_CAP + "（ここまで）</span></div>";
        var ch = defById(CHALLENGE_POOL, d.challengeId);
        if (ch) html += dmRowHtml(ch.label, Math.min(d.counters[ch.key] || 0, ch.target), ch.target, !!d.challengeDone, ch.reward, "🌟");
        d.ids.forEach(function(id){ var def = defById(DAILY_POOL, id); if (def) html += dmRowHtml(def.label, Math.min(d.counters[def.key] || 0, def.target), def.target, !!d.done[id], def.reward, "・"); });
        html += '<div class="dm-head" style="margin-top:12px"><h3>🗓️ 今週の ミッション</h3><span class="dm-cap">今週の ごほうび 🪙 ' + w.earned + " / " + WEEKLY_COIN_CAP + "（ここまで）</span></div>";
        w.ids.forEach(function(id){ var def = defById(WEEKLY_POOL, id); if (def) html += dmRowHtml(def.label, Math.min(w.counters[def.key] || 0, def.target), def.target, !!w.done[id], def.reward, "・"); });
        html += '<p class="pr-note">デイリーは まいにち、今週のミッションは 月曜日に かわる。クリアすると コインは じどうで 入る。</p>';
        el.innerHTML = html;
      }
      function missionTargets(){
        var s = save.missionSet;
        return [
          { key:"near",  label:"ニアミス",       target: 15 + s * 20, unit:"回" },
          { key:"stars", label:"星を あつめる",   target: 40 + s * 50, unit:"個" },
          { key:"gold",  label:"金星を あつめる", target: 2 + s * 2,   unit:"個" }
        ];
      }
      function missionProgress(){
        var b = save.mBase || { near:0, stars:0, gold:0 };
        return { near: save.totNear - b.near, stars: save.totStars - b.stars, gold: save.totGold - b.gold };
      }
      function checkMissionSet(){
        if (save.missionSet >= 9) return false;
        var t = missionTargets(), p = missionProgress();
        if (p.near >= t[0].target && p.stars >= t[1].target && p.gold >= t[2].target){
          save.missionSet++;
          save.mBase = { near: save.totNear, stars: save.totStars, gold: save.totGold };
          return true;
        }
        return false;
      }
      function permMult(){ return (1 + 0.02 * (save.level - 1)) * (1 + 0.10 * save.upg.mult) * (1 + 0.05 * st().score) * missionMult(); }
      /* ranked runs use fixed baseline stats: every in-run helper below returns the baseline when G is a ranked run */
      function isRankedRun(){ return !!(G && G.mode === "ranked"); }
      function runMult(){ return isRankedRun() ? 1 : permMult(); }
      function runLuck(){ return isRankedRun() ? 1 : luckFactor(); }
      function runMagnetRadius(){ if (isRankedRun()) return 80; var r = magnetRadius(); if (G && G.skillId === "hina") r = Math.round(r * 1.15); return r; }
      function clutchNote(){ if (G && G.time <= 10 && G.time > 0){ G.clutchNear++; if (G.combo > G.clutchMaxCombo) G.clutchMaxCombo = G.combo; } }
      /* ---- LIVES: max 5, start consumes 1, +1 per hour, persisted timestamp ---- */
      var LIVES_MAX = 5, LIFE_MS = 3600000;
      function refreshLives(){
        if (save.lives === undefined) save.lives = LIVES_MAX;
        if (!save.livesTs) { save.livesTs = Date.now(); persist(); return; }
        if (save.lives >= LIVES_MAX){ save.lives = LIVES_MAX; return; }
        var gained = Math.floor((Date.now() - save.livesTs) / LIFE_MS);
        if (gained > 0){
          save.lives = Math.min(LIVES_MAX, save.lives + gained);
          save.livesTs = save.lives >= LIVES_MAX ? Date.now() : save.livesTs + gained * LIFE_MS;
          persist();
        }
      }
      function livesNextMs(){ refreshLives(); if (save.lives >= LIVES_MAX) return 0; return Math.max(0, save.livesTs + LIFE_MS - Date.now()); }
      function fmtCountdown(ms){ var s = Math.ceil(ms/1000); var m = Math.floor(s/60); var ss = s%60; return (m<10?"0":"")+m+":"+(ss<10?"0":"")+ss; }
      function consumeLife(){
        if (publicMode()) return true;   // こうかい版モード: ライフは へらない（保存されている数は そのまま）
        refreshLives();
        if (save.lives <= 0) return false;
        var wasFull = save.lives >= LIVES_MAX;
        save.lives--;
        if (wasFull) save.livesTs = Date.now();
        persist(); return true;
      }
      /* ---- STATUS: 2 points per level, free reset, saved with the rest ---- */
      function st(){ if (!save.status) save.status = { speed:0, magnet:0, luck:0, shield:0, score:0 }; return save.status; }
      function statusTotalPoints(){ return (save.level - 1) * 2; }
      function statusUsed(){ var s = st(); return s.speed + s.magnet + s.luck + s.shield + s.score; }
      function statusRemaining(){ return Math.max(0, statusTotalPoints() - statusUsed()); }
      function luckFactor(){ return 1 + 0.18 * st().luck; }
      function startShieldCharges(){ return Math.min(5, save.upg.shield + st().shield); }
      var STATUS_DEF = [
        { key:"speed",  ic:"⚡", name:"スピード", max:10, per:"1Lvごとに うごく速さ +12%", cur:function(v){ return "いま： うごく速さ ×" + (1 + 0.12*v).toFixed(2) + "（指に すばやく ついてくる）"; } },
        { key:"magnet", ic:"🧲", name:"マグネット", max:10, per:"1Lvごとに 引きよせる はんい +20px", cur:function(v){ return "いま： 引きよせる はんい " + magnetRadius() + "px（マグネットの時）"; } },
        { key:"luck",   ic:"🍀", name:"ラック", max:10, per:"1Lvごとに 金星・ボーナスアイテムが 出やすく +18%", cur:function(v){ return "いま： 出やすさ ×" + luckFactor().toFixed(2); } },
        { key:"shield", ic:"🛡️", name:"シールド", max:5, per:"1Lvごとに はじめの シールド +1まい（ぜんぶで さいだい5）", cur:function(v){ return "いま： はじめの シールド " + startShieldCharges() + "まい（つよくした分も 入れて）"; } },
        { key:"score",  ic:"✨", name:"スコア", max:10, per:"1Lvごとに スコア +5%", cur:function(v){ return "いま： スコアの倍率 ×" + permMult().toFixed(2) + "（ミッションの分も 入れて）"; } }
      ];
      function magnetRadius(){ return 80 + 30 * save.upg.magnet + 20 * st().magnet; }
      var pendingLevels = 0;
      function addXP(n){
        save.xp += n;
        while (save.xp >= xpNeed()){
          save.xp -= xpNeed();
          save.level++;
          pendingLevels++;
        }
        persist();
      }

      /* ================= SKINS / SHOP DATA ================= */
      var SKINS = {
        normal:  { body:"#22d3ee", glow:"rgba(34,211,238,",  name:"ノーマルオーブ" },
        phantom: { body:"#fb3b7f", glow:"rgba(251,59,127,",  name:"ネオンファントム" },
        comet:   { body:"#ffd23f", glow:"rgba(255,210,63,",  name:"ゴールドコメット" },
        inferno: { body:"#ff5a2a", glow:"rgba(255,90,42,",   name:"インフェルノ" },
        mint:    { body:"#3ddc84", glow:"rgba(61,220,132,",  name:"ミントアメーバ" },
        grape:   { body:"#b388ff", glow:"rgba(179,136,255,", name:"ぶどうアメーバ" },
        sakura:  { body:"#ff9ecb", glow:"rgba(255,158,203,", name:"さくらアメーバ" },
        stripe:  { body:"#e8ecf4", glow:"rgba(127,178,255,", name:"ストライプボール" },
        endless_comet: { body:"#7ef0ff", glow:"rgba(126,240,255,", name:"コメット" },
        lim_snow:  { body:"#dbeafe", glow:"rgba(219,234,254,", name:"ゆきあかり（いまだけ）" },
        lim_pumpkin:{ body:"#ff9f1c", glow:"rgba(255,159,28,",  name:"かぼちゃナイト（いまだけ）" },
        lim_yozakura:{ body:"#c084fc", glow:"rgba(192,132,252,", name:"よざくら（いまだけ）" }
      };
      var SKIN_SHOP = [
        { id:"phantom", ic:"👻", cls:"ic-pink", price:300, title:"スキン「ネオンファントム」",
          desc:"銀ボールの まわりの 輪と 残像が ピンクに かわる（ボールは 銀のまま・見た目だけ）。" },
        { id:"comet", ic:"🌠", cls:"ic-gold", price:800, title:"スキン「ゴールドコメット」",
          desc:"銀ボールの まわりの 輪と 残像が オレンジに かわる（ボールは 銀のまま・見た目だけ）。" },
        { id:"inferno", ic:"🔥", cls:"ic-red", price:1500, title:"スキン「インフェルノ」",
          desc:"銀ボールの まわりの 輪と 残像が ほのお色に かわる（ボールは 銀のまま・見た目だけ）。" },
        { id:"stripe", ic:"🍬", cls:"ic-cyan", price:600, title:"スキン「ストライプボール」",
          desc:"銀ボールに 青い しまもようが つく（見た目だけ）。形で わかる 新しい スキン。" }
      ];
      var UPGRADES = [
        { id:"magnet", ic:"🧲", cls:"ic-cyan", title:"マグネットの はんい",
          desc:function(lv){ return lv >= 5 ? "いちばん上まで いった" : "つぎで はんけい " + (80 + 30 * (lv + 1)) + "px（いま " + (80 + 30 * lv) + "px）"; },
          prices:[150, 300, 550, 900, 1400] },
        { id:"shield", ic:"🛡️", cls:"ic-green", title:"はじめの シールド",
          desc:function(lv){ return lv >= 3 ? "いちばん上まで いった" : "走りはじめから シールド +" + (lv + 1) + " まい（ダメージ 1回 なし）"; },
          prices:[200, 450, 800] },
        { id:"mult", ic:"✨", cls:"ic-gold", title:"スコアの倍率",
          desc:function(lv){ return lv >= 5 ? "いちばん上まで いった" : "スコアが ずっと +" + ((lv + 1) * 10) + "%（いま +" + (lv * 10) + "%）"; },
          prices:[180, 350, 600, 1000, 1500] }
      ];
      var COIN_PACKS = [
        { coins:120,  price:"¥120" },
        { coins:300,  price:"¥250" },
        { coins:650,  price:"¥480" }
      ];
      var RANK_SAMPLE = [
        { name:"ゆうと", score: 9200 },
        { name:"ミサキ", score: 8450 },
        { name:"KAZU",   score: 7680 },
        { name:"りんご", score: 6540 },
        { name:"タクミ", score: 5320 },
        { name:"sora",   score: 4180 }
      ];

      /* ================= DOM ================= */
      function $(id){ return document.getElementById(id); }
      var views = { home:$("view-home"), menu:$("view-menu"), collection:$("view-collection"), game:$("view-game"), result:$("view-result"), shop:$("view-shop"), status:$("view-status"), gacha:$("view-gacha"), settings:$("view-settings"), guide:$("view-guide"), friend:$("view-friend"), ranked:$("view-ranked"), daily:$("view-daily"), growth:$("view-growth"), records:$("view-records"), season:$("view-season") };
      function showView(name){
        if (name === "friend" && publicMode()) name = "home";   // こうかい版モード: フレンドページには どこからも 行けない
        if (name !== "game" && typeof bgmStop === "function") bgmStop();   // BGM lives only on the game screen
        Object.keys(views).forEach(function(k){ views[k].classList.toggle("active", k===name); });
        // CRT / retro overlay exists only while the play screen is shown
        document.getElementById("app").classList.toggle("playing", name === "game");
        var sc = views[name].querySelector(".scroll");
        if (sc) sc.scrollTop = 0;
      }
      var toastTimer = null;
      function toast(msg){
        var t = $("toast"); t.textContent = msg; t.classList.add("on");
        clearTimeout(toastTimer); toastTimer = setTimeout(function(){ t.classList.remove("on"); }, 2600);
      }
      function vibrate(ms){ if (save.settings && !save.settings.vib) return; if (navigator.vibrate) { try{ navigator.vibrate(ms); }catch(e){} } }

      /* ================= AUDIO (WebAudio synth) ================= */
      var AC = null;
      function audio(){
        if (!AC){ try{ AC = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} }
        if (AC && AC.state === "suspended") AC.resume();
        return AC;
      }
      function beep(freq, dur, type, vol, slideTo, delay){
        if (save.settings && !save.settings.sound) return;
        var ac = audio(); if(!ac) return;
        var t0 = ac.currentTime + (delay || 0);
        var o = ac.createOscillator(), g = ac.createGain();
        o.type = type||"sine"; o.frequency.setValueAtTime(freq, t0);
        if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
        g.gain.setValueAtTime(vol||0.12, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
        o.connect(g); g.connect(ac.destination);
        o.start(t0); o.stop(t0 + dur);
      }
      var sfx = {
        star:   function(){ beep(880,.09,"sine",.14); beep(1318,.12,"sine",.12,0,.055); },
        gold:   function(){ [523,659,784,1046,1318,1568].forEach(function(f,i){ beep(f,.22,"triangle",.14,0,i*.07); }); },
        bonus:  function(){ [988,1318,1568,2093].forEach(function(f,i){ beep(f,.16,"square",.1,0,i*.06); }); },
        item:   function(){ beep(660,.08,"square",.08); beep(990,.14,"square",.08,0,.06); },
        near:   function(c){ beep(300 + Math.min(c,15)*40,.16,"sawtooth",.07,900); },
        crash:  function(){ beep(220,.35,"square",.16,55); },
        shield: function(){ beep(520,.12,"triangle",.14,1040); beep(1040,.16,"triangle",.1,1560,.07); },
        count:  function(){ beep(520,.08,"sine",.1); },
        go:     function(){ beep(1046,.22,"sine",.14); },
        alarm:  function(){ beep(740,.14,"square",.12); beep(740,.14,"square",.12,0,.2); beep(988,.3,"square",.12,0,.4); },
        mile:   function(c){ var base = c >= 20 ? 660 : c >= 10 ? 587 : 523; [1,1.25,1.5,2].forEach(function(m,i){ beep(base*m,.16,"triangle",.13,0,i*.06); }); },
        levelup:function(){ [523,659,784,1046,784,1046,1318].forEach(function(f,i){ beep(f,.24,"triangle",.14,0,i*.09); }); },
        gate:   function(){ [392,523,659,784,1046].forEach(function(f,i){ beep(f,.14,"square",.1,0,i*.05); }); },
        boom:   function(){ beep(160,.32,"square",.17,40); beep(90,.42,"sawtooth",.13,30,.02); beep(620,.14,"square",.09,1400,.0); beep(1240,.18,"triangle",.1,0,.07); },
        record: function(){ [660,880,1108,1318].forEach(function(f,i){ beep(f,.16,"triangle",.13,0,i*.09); }); },
        box:    function(){ [523,659,784,1046].forEach(function(f,i){ beep(f,.14,"triangle",.12,0,i*.07); }); },
        buy:    function(){ beep(784,.1,"sine",.12); beep(1174,.18,"sine",.12,0,.07); }
      };

      /* ================= BGM (all-original chiptune, synthesized live with Web Audio — no audio files, no external music) =================
         3 loop tracks built from note patterns (MIDI numbers, 0 = rest), 32 eighth-note steps = 4 bars.
         BGM plays ONLY during a run, through its own gain node kept quieter than the SFX.
         Last-10s (clutch): tempo x1.12 + a small volume lift. "off" = external-music mode: no BGM, SFX only. */
      function mf(m){ return 440 * Math.pow(2, (m - 69) / 12); }
      var BGM_TRACKS = {
        pop: {
          name: "キラキラポップ", bpm: 112, leadWave: "square", leadVol: 0.05, leadLen: 0.92,
          bassWave: "triangle", bassVol: 0.085, bassLen: 0.9, hat: true,
          lead: [76,79,81,79,76,74,72,74, 74,79,83,81,79,76,74,76, 81,84,83,81,79,76,79,81, 81,79,77,76,74,76,72,0],
          bass: [48,0,55,0,48,0,55,0, 43,0,50,0,43,0,50,0, 45,0,52,0,45,0,52,0, 41,0,48,0,41,0,48,0]
        },
        speed: {
          name: "ドキドキスピード", bpm: 152, leadWave: "sawtooth", leadVol: 0.032, leadLen: 0.9,
          bassWave: "square", bassVol: 0.06, bassLen: 0.85, hat: true,
          lead: [69,72,76,81,76,72,76,81, 81,79,77,76,77,81,79,76, 76,79,84,83,84,79,76,79, 83,81,79,81,83,86,83,81],
          bass: [45,57,45,45,57,45,52,45, 41,53,41,41,53,41,48,41, 48,60,48,48,60,48,55,48, 43,55,43,43,55,43,50,43]
        },
        chill: {
          name: "まったりチル", bpm: 76, leadWave: "triangle", leadVol: 0.06, leadLen: 1.9,
          bassWave: "sine", bassVol: 0.08, bassLen: 3, hat: false,
          lead: [72,0,76,0,79,0,76,0, 81,0,79,0,76,0,74,0, 77,0,81,0,84,0,81,0, 83,0,79,0,76,0,0,0],
          bass: [48,0,0,0,55,0,0,0, 45,0,0,0,52,0,0,0, 41,0,0,0,48,0,0,0, 43,0,0,0,50,0,0,0],
          pads: [[60,64,67,71],[57,60,64,67],[53,57,60,64],[55,59,62,65]]
        }
      };
      function bgmId(){
        var id = (save.settings && save.settings.bgm) || "pop";
        return (id === "off" || BGM_TRACKS[id]) ? id : "pop";
      }
      function bgmName(){ var id = bgmId(); return id === "off" ? "オフ" : BGM_TRACKS[id].name; }
      var bgm = { on:false, timer:null, step:0, nextTime:0, id:null, preview:false, stopTimer:null, gain:null, final:false, tempoMul:1 };
      function bgmGainNode(){
        var ac = audio(); if (!ac) return null;
        if (!bgm.gain){ bgm.gain = ac.createGain(); bgm.gain.gain.value = 0.9; bgm.gain.connect(ac.destination); }
        return bgm.gain;
      }
      function bgmNote(midi, t, dur, wave, vol, dest){
        if (!midi) return;
        var o = AC.createOscillator(), g = AC.createGain();
        o.type = wave; o.frequency.setValueAtTime(mf(midi), t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(dest);
        o.start(t); o.stop(t + dur + 0.05);
      }
      function bgmScheduleStep(step, t){
        var tr = BGM_TRACKS[bgm.id]; if (!tr) return;
        var dest = bgmGainNode(); if (!dest) return;
        var stepDur = 60 / (tr.bpm * bgm.tempoMul) / 2;
        var i = step % tr.lead.length;
        bgmNote(tr.lead[i], t, stepDur * tr.leadLen, tr.leadWave, tr.leadVol, dest);
        bgmNote(tr.bass[i], t, stepDur * tr.bassLen, tr.bassWave, tr.bassVol, dest);
        if (tr.hat && i % 2 === 1) bgmNote(108, t, 0.03, "square", 0.008, dest);
        if (tr.pads && i % 8 === 0){
          var pad = tr.pads[(i / 8) | 0];
          for (var pi = 0; pi < pad.length; pi++) bgmNote(pad[pi], t, stepDur * 7.6, "triangle", 0.016, dest);
        }
      }
      function bgmTick(){
        if (!bgm.on || !AC) return;
        var tr = BGM_TRACKS[bgm.id]; if (!tr) return;
        while (bgm.nextTime < AC.currentTime + 0.14){
          bgmScheduleStep(bgm.step, bgm.nextTime);
          bgm.nextTime += 60 / (tr.bpm * bgm.tempoMul) / 2;
          bgm.step++;
        }
      }
      function bgmPlay(preview){
        if (bgmId() === "off"){ bgmStop(); return; }
        if (save.settings && !save.settings.sound){ bgmStop(); return; }   // follows the existing mute (サウンド) setting
        var ac = audio(); if (!ac) return;
        bgmStop();
        bgm.on = true; bgm.id = bgmId(); bgm.preview = !!preview; bgm.step = 0; bgm.final = false; bgm.tempoMul = 1;
        var dest = bgmGainNode(); if (dest) dest.gain.setTargetAtTime(0.9, ac.currentTime, 0.05);
        bgm.nextTime = ac.currentTime + 0.06;
        bgm.timer = setInterval(bgmTick, 40);
        bgmTick();
        if (preview) bgm.stopTimer = setTimeout(function(){ if (bgm.preview) bgmStop(); }, 6500);
      }
      function bgmStop(){
        if (bgm.timer){ clearInterval(bgm.timer); bgm.timer = null; }
        if (bgm.stopTimer){ clearTimeout(bgm.stopTimer); bgm.stopTimer = null; }
        bgm.on = false; bgm.preview = false; bgm.final = false; bgm.tempoMul = 1;
      }
      /* last-10s clutch lift: tempo x1.12 and a small volume rise, BGM only */
      function bgmSetFinal(on){
        if (!bgm.on || bgm.preview || on === bgm.final) return;
        bgm.final = on;
        bgm.tempoMul = on ? 1.12 : 1;
        if (bgm.gain && AC) bgm.gain.gain.setTargetAtTime(on ? 1.15 : 0.9, AC.currentTime, 0.4);
      }
      function renderBgm(){
        var cur = bgmId();
        Array.prototype.forEach.call(document.querySelectorAll("[data-bgm]"), function(b){
          var on = b.getAttribute("data-bgm") === cur;
          b.classList.toggle("on", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
          var st = b.querySelector(".bgm-state");
          if (st) st.textContent = on ? "✓ えらんでいる" : "▶ 試し聞き";
        });
      }
      document.addEventListener("visibilitychange", function(){
        if (document.hidden){ bgmStop(); return; }
        try { if (typeof G !== "undefined" && G && G.running && !G.over) bgmPlay(false); } catch(e){}
      });

      /* ================= RANKING ================= */
      function renderRanking(el, myScore, myRevived){
        if (!el) return;
        if (myScore === undefined) myScore = save.best;
        if (myRevived === undefined) myRevived = save.bestRevived;
        var rows = RANK_SAMPLE.map(function(r){ return { name:r.name, score:r.score, me:false, revived:false }; });
        rows.push({ name:"あなた", score: myScore, me:true, revived: myRevived });
        rows.sort(function(a,b){ return b.score - a.score; });
        var top = rows.slice(0,6);
        if (!top.some(function(r){return r.me;})) top.push(rows.find(function(r){return r.me;}));
        el.innerHTML = top.map(function(r){
          var idx = rows.indexOf(r);
          var crown = idx===0 ? ' <span class="crown">👑</span>' : "";
          return '<div class="rank-row'+(r.me?' me':'')+'">' +
            '<div class="pos">'+(idx+1)+'</div>' +
            '<div class="nm">'+r.name+crown+(r.revived?' <small style="color:var(--ink-dim);font-size:11px">（ふっかつ ベスト）</small>':'')+'</div>' +
            '<div class="sc">'+r.score.toLocaleString()+'</div></div>';
        }).join("");
      }
      function renderRankings(){ renderRanking($("rank-list")); renderRanking($("rank-list-result")); }

      /* ================= HOME / SHOP RENDER ================= */
      /* pixel heart: one stepped path for both states — filled = solid red,
         empty = dark fill with a bright outline, so state never relies on hue alone */
      var HEART_PATH = "M1 0H4V1H5V2H6V1H7V0H10V1H11V4H10V6H9V7H8V8H7V9H6V10H5V9H4V8H3V7H2V6H1V4H0V1H1Z";
      /* smooth heart for the modern (non-play) screens; the stepped pixel
         heart is kept for the in-game HUD only */
      var HEART_SMOOTH_PATH = "M12 21s-7.6-4.95-10.1-9.4C.35 8.1 2.3 4.6 5.7 4.6c1.75 0 3.45.95 4.3 2.35.85-1.4 2.55-2.35 4.3-2.35 3.4 0 5.35 3.5 3.8 7C19.6 16.05 12 21 12 21z";
      function heartsHtml(smooth, count){
        var n = (count === undefined ? save.lives : count);
        var s = "";
        for (var i = 0; i < LIVES_MAX; i++){
          s += '<span class="px-heart ' + (smooth ? "smooth " : "") + (i < n ? "filled" : "empty") + '" aria-hidden="true">' +
            (smooth
              ? '<svg viewBox="0 0 24 24" focusable="false"><path d="' + HEART_SMOOTH_PATH + '"/></svg></span>'
              : '<svg viewBox="0 0 11 10" focusable="false"><path d="' + HEART_PATH + '"/></svg></span>');
        }
        return s;
      }
      function setLivesPanel(prefix, full, nextMs, pct){
        var pub = publicMode();
        var dispFull = pub ? true : full;
        var h = $(prefix + "-lives-hearts");
        if (h){ h.innerHTML = heartsHtml(true, pub ? LIVES_MAX : save.lives); h.setAttribute("aria-label", pub ? "ライフ むげん" : "ライフ " + save.lives + " / " + LIVES_MAX); }
        var c = $(prefix + "-lives-count");
        if (c) c.innerHTML = pub ? "<small>ライフ</small>むげん" : "<small>のこり</small>" + save.lives + " / " + LIVES_MAX;
        var lbl = $(prefix + "-lives-recovery-label");
        if (lbl) lbl.textContent = pub ? "ライフ むげん" : (full ? "ライフ まんたん" : "つぎの ライフまで");
        var tm = $(prefix + "-lives-timer");
        if (tm){ tm.textContent = pub ? "むげん" : (full ? "FULL" : fmtCountdown(nextMs)); tm.classList.toggle("is-full", dispFull); }
        var bar = $(prefix + "-lives-bar");
        if (bar) bar.classList.toggle("is-full", dispFull);
        var fill = $(prefix + "-lives-fill");
        if (fill) fill.style.width = (pub ? 100 : pct) + "%";
      }
      function renderLives(){
        refreshLives();
        var pub = publicMode();
        var full = save.lives >= LIVES_MAX;
        var nextMs = livesNextMs();
        var pct = full ? 100 : Math.max(0, Math.min(100, Math.round((1 - nextMs / LIFE_MS) * 100)));
        setLivesPanel("home", full, nextMs, pct);
        setLivesPanel("result", full, nextMs, pct);
        var note = $("home-lives-note");
        if (note) note.textContent = pub
          ? "こうかい版モード： ライフは むげんだよ（へらない）"
          : (full
            ? "まんたんだよ — 1時間で 1つ もどる（さいだい5）／ スタートで 1つ つかう"
            : "あと " + fmtCountdown(nextMs) + " で +1 もどる — 1時間で 1つ（さいだい5）／ スタートで 1つ つかう");
        var rnote = document.querySelector(".result-lives .lives-note");
        if (rnote) rnote.textContent = pub
          ? "こうかい版モード： ライフは むげん。何回でも あそべるよ"
          : "「もう1回」でも スタートで ライフ1つ つかう ／ 1時間で 1つ もどる（さいだい5）";
        var rb = $("btn-refill-lives");
        if (rb){
          rb.style.display = pub ? "none" : "";
          rb.disabled = full;
          rb.textContent = full ? "ライフ まんたんです（5 / 5）" : "❤️ ライフ ぜんぶ もどす ¥160（モック）";
        }
        // game HUD: same hearts + count, compact and out of the drag area
        var hh = $("hud-lives-hearts"); if (hh) hh.innerHTML = heartsHtml(false, pub ? LIVES_MAX : save.lives);
        var hc = $("hud-lives-count"); if (hc) hc.textContent = pub ? "むげん" : save.lives + "/" + LIVES_MAX;
        var hn = $("hud-lives-next");
        if (hn) hn.innerHTML = pub ? "<b>むげん</b>" : (full ? "<b>FULL</b>" : 'つぎに もどる <b>' + fmtCountdown(nextMs) + "</b>");
        var pb = $("btn-play"); if (pb) pb.textContent = "▶ スタート";
      }
      function renderStatus(){
        var el = $("status-list"); if (!el) return;
        $("status-points").textContent = statusRemaining();
        var s = st();
        el.innerHTML = STATUS_DEF.map(function(d){
          var v = s[d.key], maxed = v >= d.max, canAdd = !maxed && statusRemaining() > 0;
          return '<div class="status-row"><span class="sic">' + d.ic + '</span>' +
            '<span class="smid"><span class="stt">' + d.name + '</span>' +
            '<span class="sds">' + d.per + '<br /><b>' + d.cur(v) + '</b></span></span>' +
            '<span class="status-btns"><button class="status-btn" data-stminus="' + d.key + '"' + (v<=0?" disabled":"") + '>−</button>' +
            '<span class="status-lv">Lv.' + v + (maxed ? " MAX" : "") + '</span>' +
            '<button class="status-btn plus" data-stplus="' + d.key + '"' + (canAdd?"":" disabled") + '>＋</button></span></div>';
        }).join("");
        Array.prototype.forEach.call(el.querySelectorAll("[data-stplus]"), function(b){
          b.addEventListener("click", function(){ var k = b.getAttribute("data-stplus"); if (statusRemaining() > 0 && st()[k] < STATUS_DEF.find(function(d){return d.key===k;}).max){ st()[k]++; persist(); sfx.buy(); renderAll(); } });
        });
        Array.prototype.forEach.call(el.querySelectorAll("[data-stminus]"), function(b){
          b.addEventListener("click", function(){ var k = b.getAttribute("data-stminus"); if (st()[k] > 0){ st()[k]--; persist(); renderAll(); } });
        });
      }
      function renderHome(){
        $("home-best").textContent = save.best.toLocaleString();
        $("home-streak").textContent = save.streak;
        $("home-coins").textContent = save.coins.toLocaleString();
        $("home-level").textContent = "Lv." + save.level;
        $("home-lvbonus").textContent = "スコアの倍率 ×" + permMult().toFixed(2);
        $("home-xpnext").textContent = "あと " + (xpNeed() - save.xp) + " XP";
        $("home-xpfill").style.width = Math.min(save.xp / xpNeed() * 100, 100) + "%";
      }
      function shortfallHtml(price){
        if (save.coins >= price) return "";
        var short = price - save.coins;
        var pct = Math.floor(save.coins / price * 100);
        return '<span class="prog-wrap"><span class="prog-bar"><span class="prog-fill" style="display:block;width:' + pct + '%"></span></span>' +
          '<span class="prog-tx">あと ' + short + ' コインで 買える（もっている ' + save.coins + ' / ' + price + '）　' + (publicMode() ? '<span>コインは あそぶと たまるよ</span>' : '<span class="pack-link">コインパックを 見る ›</span>') + '</span></span>';
      }
      function pipsHtml(lv, max){
        var s = '<span class="pips">';
        for (var i = 0; i < max; i++) s += '<span class="pip' + (i < lv ? ' on' : '') + '"></span>';
        return s + '</span>';
      }
      function renderShop(){
        // upgrades
        $("upg-grid").innerHTML = UPGRADES.map(function(u){
          var lv = save.upg[u.id], maxed = lv >= u.prices.length;
          var right = maxed
            ? '<div class="p owned-tag">MAX</div>'
            : '<div class="p">🪙 ' + u.prices[lv] + '</div><div class="b">' + (save.coins >= u.prices[lv] ? "コインで つよくする" : "コインが たりない") + '</div>';
          return '<button class="shop-card" data-upg="' + u.id + '">' +
            '<span class="shop-ic ' + u.cls + '">' + u.ic + '</span>' +
            '<span class="mid"><span class="tt">' + u.title + pipsHtml(lv, u.prices.length) + '</span>' +
            '<span class="ds">' + u.desc(lv) + '</span>' + (maxed ? "" : shortfallHtml(u.prices[lv])) + '</span>' +
            '<span class="pr">' + right + '</span></button>';
        }).join("");
        // skins
        var skinHtml = SKIN_SHOP.map(function(it){
          var owned = save.owned[it.id], equipped = save.skin === it.id;
          var right;
          if (owned) right = '<div class="p owned-tag">' + (equipped ? "つかっている" : "買った") + '</div><div class="b">' + (equipped ? "" : "タップで つかう") + '</div>';
          else right = '<div class="p">🪙 ' + it.price + '</div><div class="b">' + (save.coins >= it.price ? "コインで 買う" : "コインが たりない") + '</div>';
          return '<button class="shop-card" data-skin="' + it.id + '">' +
            '<span class="shop-ic ' + it.cls + '">' + it.ic + '</span>' +
            '<span class="mid"><span class="tt">' + it.title + '</span><span class="ds">' + it.desc + '</span>' + (owned ? "" : shortfallHtml(it.price)) + '</span>' +
            '<span class="pr">' + right + '</span></button>';
        }).join("");
        skinHtml += '<div class="shop-card locked">' +
          '<span class="shop-ic ic-cyan">🤝</span>' +
          '<span class="mid"><span class="tt">コラボスキン</span><span class="ds">コラボは まだ きまっていない。きまったら ここに 出るよ。</span></span>' +
          '<span class="pr"><div class="p" style="color:var(--ink-dim)">COMING<br />SOON</div></span></div>';
        [["mint","🍃"],["grape","🍇"],["sakura","🌸"]].forEach(function(gs){
          var gid = gs[0], gOwned = save.owned[gid], gEq = save.skin === gid;
          skinHtml += '<button class="shop-card" data-gskin="' + gid + '">' +
            '<span class="shop-ic ic-green">' + gs[1] + '</span>' +
            '<span class="mid"><span class="tt">スキン「' + SKINS[gid].name + '」</span><span class="ds">ガチャだけの スキン（見た目だけ・強さは かわらない）。かぶったら コインに かわる。</span></span>' +
            '<span class="pr">' + (gOwned ? '<div class="p owned-tag">' + (gEq ? "つかっている" : "買った") + '</div><div class="b">' + (gEq ? "" : "タップで つかう") + '</div>' : '<div class="p" style="color:var(--ink-dim)">ガチャで<br />ゲット</div>') + '</span></button>';
        });
        // trails (こんせき): sakura is sold for coins; the season trail appears once owned
        (function(){
          var tr = trails();
          var skOwned = !!tr.sakura, skEq = tr.equip === "sakura";
          skinHtml += '<button class="shop-card" data-trail="sakura">' +
            '<span class="shop-ic ic-pink">🌸</span>' +
            '<span class="mid"><span class="tt">こんせき「さくらふぶき」</span><span class="ds">ボールの 通った あとに さくらの 花びらが まう（見た目だけ）。</span>' + (skOwned ? "" : shortfallHtml(500)) + '</span>' +
            '<span class="pr">' + (skOwned ? '<div class="p owned-tag">' + (skEq ? "つけている" : "買った") + '</div><div class="b">' + (skEq ? "タップで はずす" : "タップで つける") + '</div>' : '<div class="p">🪙 500</div><div class="b">' + (save.coins >= 500 ? "コインで 買う" : "コインが たりない") + '</div>') + '</span></button>';
          if (tr.season){
            var seEq = tr.equip === "season";
            skinHtml += '<button class="shop-card" data-trail="season">' +
              '<span class="shop-ic ic-cyan">🌸</span>' +
              '<span class="mid"><span class="tt">こんせき「シーズンのきらめき」</span><span class="ds">シーズンの ごほうびの こんせき。水色に きらめく（見た目だけ）。</span></span>' +
              '<span class="pr"><div class="p owned-tag">' + (seEq ? "つけている" : "買った") + '</div><div class="b">' + (seEq ? "タップで はずす" : "タップで つける") + '</div></span></button>';
          }
        })();
        $("skin-grid").innerHTML = skinHtml;
        // misc — こうかい版モードでは ¥で買う カード（ライフ全回復・広告オフパス・
        // コインパック）は 項目ごと 出さない。コインで買う ボックスは そのまま。
        var pub = publicMode();
        $("misc-grid").innerHTML =
          (pub ? "" :
          '<button class="shop-card" data-misc="lives">' +
            '<span class="shop-ic ic-red">❤️</span>' +
            '<span class="mid"><span class="tt">ライフ ぜんぶ もどす</span><span class="ds">ライフは 1時間で 1つ もどる（さいだい5）。まてない時の モック。ふっかつ（コイン）とは べつ。</span></span>' +
            '<span class="pr"><div class="p">¥160</div><div class="b">モックで買う</div></span></button>' +
          '<button class="shop-card" data-misc="pass">' +
            '<span class="shop-ic ic-gold">🎫</span>' +
            '<span class="mid"><span class="tt">パス「広告なし＋ごほうび2倍」</span><span class="ds">広告なしで さくさく。宝箱の コインが ずっと 2倍に なる。</span></span>' +
            '<span class="pr">' + (save.pass ? '<div class="p owned-tag">つかっている</div>' : '<div class="p">¥250 / 月</div><div class="b">モックで買う</div>') + '</span></button>' +
          '<button class="shop-card" data-misc="pack">' +
            '<span class="shop-ic ic-gold">🪙</span>' +
            '<span class="mid"><span class="tt">コインパック</span><span class="ds">あと少しで 買える… その「少し」を たす パック。</span></span>' +
            '<span class="pr"><div class="p">¥120〜¥480</div><div class="b">モックで買う</div></span></button>') +
          '<button class="shop-card" data-misc="box">' +
            '<span class="shop-ic ic-pink">🎁</span>' +
            '<span class="mid"><span class="tt">ミステリーボックス</span><span class="ds">中身の かくりつ： コイン120（45%）／コイン350（30%）／コイン800（15%）／もっていない スキン（10%、かぶったら コイン300に かわる）</span>' + shortfallHtml(500) + '</span>' +
            '<span class="pr"><div class="p">🪙 500</div><div class="b">かくりつ 公開</div></span></button>';
        Array.prototype.forEach.call(document.querySelectorAll("[data-upg]"), function(btn){
          btn.addEventListener("click", function(){ onUpgradeTap(btn.getAttribute("data-upg")); });
        });
        Array.prototype.forEach.call(document.querySelectorAll("[data-skin]"), function(btn){
          btn.addEventListener("click", function(){ onSkinTap(btn.getAttribute("data-skin")); });
        });
        Array.prototype.forEach.call(document.querySelectorAll("[data-gskin]"), function(btn){
          btn.addEventListener("click", function(){
            var gid = btn.getAttribute("data-gskin");
            if (!save.owned[gid]){ toast("「" + SKINS[gid].name + "」は スキンガチャで ゲットできるよ"); showView("gacha"); return; }
            save.skin = save.skin === gid ? "normal" : gid; persist(); renderAll();
            toast(save.skin === gid ? "スキン「" + SKINS[gid].name + "」を つけた" : "スキンを ノーマルに もどした");
          });
        });
        Array.prototype.forEach.call(document.querySelectorAll("[data-trail]"), function(btn){
          btn.addEventListener("click", function(){
            var tid = btn.getAttribute("data-trail");
            var tr = trails();
            if (tid === "sakura" && !tr.sakura){
              if (save.coins < 500){ openPackSheet(500 - save.coins, "こんせき「さくらふぶき」"); return; }
              save.coins -= 500; trackSpend(500); tr.sakura = true; tr.equip = "sakura"; persist(); sfx.buy(); renderAll();
              toast("こんせき「さくらふぶき」を 買って つけた（見た目だけ）");
              return;
            }
            tr.equip = tr.equip === tid ? "none" : tid; persist(); renderAll();
            toast(tr.equip === tid ? "こんせきを つけた" : "こんせきを はずした");
          });
        });
        Array.prototype.forEach.call(document.querySelectorAll("[data-misc]"), function(btn){
          btn.addEventListener("click", function(){ onMiscTap(btn.getAttribute("data-misc")); });
        });
      }
      function renderMissions(){
        var el = $("mission-list");
        if (!el) return;
        $("mission-mult").textContent = "×" + missionMult();
        if (save.missionSet >= 9){
          el.innerHTML = '<div class="m-row"><div class="mt-t"><span>🏆 スコアの倍率は さいだい（×10）に なった</span><span class="done">MAX</span></div></div>';
          return;
        }
        var t = missionTargets(), p = missionProgress();
        el.innerHTML = t.map(function(m){
          var cur = Math.min(p[m.key], m.target), done = p[m.key] >= m.target;
          var pct = Math.floor(cur / m.target * 100);
          return '<div class="m-row"><div class="mt-t"><span>' + (done ? "✅ " : "🎯 ") + m.label + '</span>' +
            '<span class="' + (done ? "done" : "") + '">' + cur + " / " + m.target + m.unit + '</span></div>' +
            '<span class="prog-wrap"><span class="prog-bar"><span class="prog-fill" style="display:block;width:' + pct + '%"></span></span></span></div>';
        }).join("");
      }
      function renderAttackHome(){
        var c = $("home-attack-count"); if (c) c.textContent = "×" + (1 + preAttacks);
        var b = $("btn-buy-attack"); if (!b) return;
        var cost = attackCost(preAttacks);
        if (cost === null){ b.disabled = true; b.innerHTML = "攻撃 MAX<br /><small>つぎは ×3（ここまで）</small>"; }
        else { b.disabled = false; b.innerHTML = "攻撃 +1<br /><small>🪙 " + cost + "（モック）</small>"; }
      }
      /* ================= FRIENDS (mock / sample only — no real accounts, no external messages) ================= */
      var FRIENDS = [
        { id:"puni", name:"ぷに丸", emoji:"🟣" },
        { id:"mochi", name:"もちアメ", emoji:"🟢" },
        { id:"dot", name:"ドットン", emoji:"🔵" },
        { id:"yuru", name:"ゆるアメ", emoji:"🩷" }
      ];
      var SEND_REWARD = 10;
      function fr(){
        if (!save.friend) save.friend = { sentDate:"", sent:{}, inbox:[], pending:false, reqCount:0, flives:{} };
        if (!save.friend.flives) save.friend.flives = {};
        if (!save.friend.inbox) save.friend.inbox = [];
        if (!save.friend.sent) save.friend.sent = {};
        return save.friend;
      }
      function friendName(id){ for (var i = 0; i < FRIENDS.length; i++) if (FRIENDS[i].id === id) return FRIENDS[i].name; return id; }
      function friendLives(id){ var v = fr().flives[id]; return v === undefined ? 3 : v; }
      function friendDayStr(){ var d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
      function ensureFriendDay(){ var f = fr(); var t = friendDayStr(); if (f.sentDate !== t){ f.sentDate = t; f.sent = {}; persist(); } }
      function enterFriendPage(){
        var f = fr(); ensureFriendDay();
        if (f.pending){
          f.pending = false; f.reqCount = (f.reqCount || 0) + 1;
          var giver = FRIENDS[f.reqCount % FRIENDS.length];
          f.inbox.push({ id:"req" + Date.now(), from: giver.id });
          persist();
          setTimeout(function(){ toast(giver.name + " から ライフが とどいた！ 「とどいたもの」で もらえるよ"); }, 350);
        }
      }
      function renderFriends(){
        var list = $("friend-list"); if (!list) return;
        ensureFriendDay(); refreshLives();
        var f = fr();
        var fc = $("friend-coins"); if (fc) fc.textContent = save.coins.toLocaleString();
        var fl = $("friend-my-lives"); if (fl) fl.textContent = save.lives + " / " + LIVES_MAX + (save.lives >= LIVES_MAX ? "（まんたん）" : "");
        var ib = $("friend-inbox");
        if (ib){
          if (!f.inbox.length){
            ib.innerHTML = '<p class="friend-empty">とどいたものは ないよ。下の「ライフを リクエスト」で フレンドに たのめる。</p>';
          } else {
            var full = save.lives >= LIVES_MAX;
            ib.innerHTML = (full ? '<p class="friend-full-note">⚠ ライフ まんたん（5 / 5）だから、今は もらえない。走って ライフを つかうと もらえる。ギフトは なくならずに のこるよ。</p>' : "") + f.inbox.map(function(g){
              return '<div class="inbox-row"><div class="inbox-info"><span class="inbox-from">❤️ ' + friendName(g.from) + ' からの ライフ</span><span class="inbox-sub">ライフ +1（あなたは いま ' + save.lives + ' / ' + LIVES_MAX + '）</span></div>' +
                (full ? '<button class="inbox-accept" disabled>まんたんで もらえない（5 / 5）</button>' : '<button class="inbox-accept" data-accept="' + g.id + '">もらう（ライフ +1）</button>') + '</div>';
            }).join("");
            Array.prototype.forEach.call(ib.querySelectorAll("[data-accept]"), function(b){
              b.addEventListener("click", function(){ acceptGift(b.getAttribute("data-accept")); });
            });
          }
        }
        var rb2 = $("btn-request-lives");
        if (rb2){ rb2.disabled = !!f.pending; rb2.textContent = f.pending ? "📨 リクエスト ずみ（つぎに 開くと とどく）" : "🙏 ライフを リクエストする"; }
        var rn = $("friend-request-note");
        if (rn) rn.textContent = f.pending ? "モックの リクエストを 送ったよ。一度 ホームに もどって、また このページを 開くと、フレンドからの ギフトが 「とどいたもの」に 入る。" : "フレンド みんなに モックの リクエストを 送るよ（そとには 送らない）。つぎに このページを 開くと ギフトが とどく。";
        list.innerHTML = FRIENDS.map(function(fd){
          var lv = friendLives(fd.id); var sent = !!f.sent[fd.id];
          return '<div class="friend-row"><div class="friend-info"><span class="friend-name">' + fd.emoji + " " + fd.name + ' <span class="friend-sample">サンプル</span></span><span class="friend-lives">ライフ ' + lv + ' / 5' + (lv >= 5 ? "（まんたん）" : "") + '</span></div>' +
            (sent ? '<button class="friend-send sent" disabled>✓ きょう 送った</button>' : '<button class="friend-send" data-send="' + fd.id + '">❤️ ライフを おくる</button>') +
            '<span class="friend-reward">' + (sent ? "あした また おくれる。おれいの コインは もらった。" : "おくると おれいに 🪙 +" + SEND_REWARD + " コイン ／ 自分の ライフは へらない") + '</span></div>';
        }).join("");
        Array.prototype.forEach.call(list.querySelectorAll("[data-send]"), function(b){
          b.addEventListener("click", function(){ sendLife(b.getAttribute("data-send")); });
        });
      }
      function sendLife(id){
        ensureFriendDay(); var f = fr();
        if (f.sent[id]) return;
        f.sent[id] = true;
        f.flives[id] = Math.min(LIVES_MAX, friendLives(id) + 1);
        save.coins += SEND_REWARD; persist(); sfx.buy(); renderAll();
        toast(friendName(id) + " に ライフを おくった！ おれいに 🪙 +" + SEND_REWARD + "（自分の ライフは へらない）");
      }
      function acceptGift(gid){
        refreshLives();
        if (save.lives >= LIVES_MAX){ toast("ライフ まんたん（5 / 5）だよ。今は もらえない"); renderAll(); return; }
        var f = fr(); var idx = -1;
        for (var i = 0; i < f.inbox.length; i++) if (f.inbox[i].id === gid) idx = i;
        if (idx < 0) return;
        var from = f.inbox[idx].from;
        f.inbox.splice(idx, 1);
        save.lives++;
        if (save.lives >= LIVES_MAX) save.livesTs = Date.now();
        persist(); sfx.item(); renderAll();
        toast(friendName(from) + " の ライフを もらった！ ライフ " + save.lives + " / " + LIVES_MAX);
      }

      /* ================= RANKED / ESPORTS ================= */
      var TIERS = [
        { name:"ブロンズ", min:0, ic:"🥉" }, { name:"シルバー", min:300, ic:"🥈" }, { name:"ゴールド", min:700, ic:"🥇" },
        { name:"プラチナ", min:1200, ic:"💎" }, { name:"ダイヤモンド", min:1800, ic:"🔷" }, { name:"マスター", min:2500, ic:"🔮" },
        { name:"レジェンド", min:3400, ic:"👑" }
      ];
      function rk(){
        if (!save.ranked) save.ranked = { rating:0, best:0, plays:0, lastDelta:0, lastNote:"まだランク戦を遊んでいません", seasonPass:false };
        return save.ranked;
      }
      function tierOf(rating){ var t = TIERS[0]; TIERS.forEach(function(x){ if (rating >= x.min) t = x; }); return t; }
      function nextTier(rating){ for (var i = 0; i < TIERS.length; i++) if (rating < TIERS[i].min) return TIERS[i]; return null; }
      function ratingDelta(score){ return Math.max(-30, Math.min(60, Math.floor(score / 80) - 15)); }
      function tourneyEnd(){
        var d = new Date();
        var e = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        var add = (8 - e.getDay()) % 7; if (add === 0) add = 7;
        e.setDate(e.getDate() + add);
        return e;
      }
      function tourneyCountdownText(){
        var s = Math.max(0, Math.floor((tourneyEnd() - new Date()) / 1000));
        var dd = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60;
        return "あと " + dd + "日 " + (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm + ":" + (ss < 10 ? "0" : "") + ss;
      }
      function renderRanked(){
        var box = $("ranked-tier-card"); if (!box) return;
        var r = rk(); var t = tierOf(r.rating); var nt = nextTier(r.rating);
        box.innerHTML = '<div class="tier-big">' + t.ic + " " + t.name + '</div>' +
          '<div class="tier-rating">レーティング <span class="num">' + r.rating.toLocaleString() + '</span> pt ／ ランク戦 ベスト <span class="num">' + r.best.toLocaleString() + '</span> ／ ランク戦 ' + r.plays + ' 回</div>' +
          (nt ? '<div class="xp-bar"><div class="xp-fill" style="width:' + Math.min(100, Math.max(0, Math.round((r.rating - t.min) / (nt.min - t.min) * 100))) + '%"></div></div><div class="tier-note">つぎの ランク（' + nt.name + '）まで あと ' + (nt.min - r.rating) + ' pt</div>' : '<div class="tier-note">いちばん上の ランクに とどいた！ 👑</div>') +
          '<div class="tier-note">' + r.lastNote + '</div>';
        var tc = $("tourney-countdown"); if (tc) tc.textContent = tourneyCountdownText();
        renderRanking($("rank-list-ranked"), r.best, false);
        renderRanking($("rank-list-casual"), save.best, save.bestRevived);
        renderRanking($("tourney-list"), r.best, false);
        var sp = $("btn-season-pass");
        if (sp){
          sp.style.display = publicMode() ? "none" : "";
          sp.disabled = !!r.seasonPass;
          sp.innerHTML = r.seasonPass ? "✓ シーズンパス つかっている（見た目だけ）" : "🎫 シーズンパス ¥480（モック）—<br />見た目だけの とくてん";
        }
        var rp = $("btn-play-ranked");
        if (rp) rp.textContent = publicMode() ? "🏆 ランク戦 スタート" : "🏆 ランク戦 スタート（ライフ −1）";
        var sn = $("ranked-sample-note");
        if (sn) sn.hidden = !publicMode();
        var fn = $("ranked-foot-note");
        if (fn) fn.textContent = publicMode()
          ? "大会と ランキングは テスト用の モック表示。"
          : "大会と ランキングは テスト用の モック表示。お金は ぜんぶ モックで、本物の お金は かからない（ねだんは ぜんぶ ¥480 以下）。";
      }

      /* ================= PERIOD-LIMITED ITEMS + LEGEND FRAGMENTS =================
         Rotation is calendar-based: a 14-day limited cycle and a 56-day legend cycle,
         both anchored to 2026-11-02 (JST). The current item can only be acquired while
         its period is running; when the period ends it moves to the past-items list and
         the next item in the pool rotates in. Anything already owned stays owned and
         usable forever — owned items are never removed or expired. */
      var LIMITED_EPOCH = Date.parse("2026-11-02T00:00:00+09:00");
      var LIMITED_MS = 14 * 24 * 3600 * 1000;
      var LEGEND_MS = 56 * 24 * 3600 * 1000;
      var FRAGMENTS_NEED = 10;
      var LIMITED_SKINS = [
        { id:"lim_snow",    name:"ゆきあかり",     price:600 },
        { id:"lim_pumpkin", name:"かぼちゃナイト", price:600 },
        { id:"lim_yozakura",name:"よざくら",       price:600 }
      ];
      var LIMITED_NAVI = [
        { id:"lim_witch",  name:"星見ウィッチ風",   color:"#5b4bc4", sub:"#ffd23f", price:450 },
        { id:"lim_kimono", name:"雪あかり着物風",   color:"#d64560", sub:"#ffffff", price:450 },
        { id:"lim_marine", name:"海ガラスドレス",   color:"#0e7c86", sub:"#aee9ff", price:450 }
      ];
      var LEGEND_POOL = [
        { id:"legend_niji",   name:"虹結びレジェンド軌跡",   desc:"銀ボールの 通った あとが 虹色に きらめく、何回も あそんだ しるし（見た目だけ）" },
        { id:"legend_hoshi",  name:"星屑レジェンドオーラ",   desc:"銀ボールの まわりに 星くずが まう、何回も あそんだ しるし（見た目だけ）" },
        { id:"legend_sakura", name:"桜嵐レジェンドフレーム", desc:"結果画面に 桜の フレームが つく、何回も あそんだ しるし（見た目だけ）" }
      ];
      function cycleOf(ms, span){ var c = Math.floor((Date.now() - LIMITED_EPOCH) / span); return c < 0 ? 0 : c; }
      function cycleStart(c, span){ return LIMITED_EPOCH + c * span; }
      function fmtD(ms){ var d = new Date(ms); return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate(); }
      function periodText(startMs, span){
        return "きかん： " + fmtD(startMs) + " 〜 " + fmtD(startMs + span - 24 * 3600 * 1000);
      }
      function countdownText(endMs){
        var s = Math.max(0, Math.floor((endMs - Date.now()) / 1000));
        var dd = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), mm = Math.floor(s % 3600 / 60);
        return "あと " + dd + "日 " + hh + "時間 " + mm + "分";
      }
      function daysLeft(endMs){ return Math.ceil((endMs - Date.now()) / (24 * 3600 * 1000)); }
      function curLimited(){ var c = cycleOf(Date.now(), LIMITED_MS); return { cycle:c, start:cycleStart(c, LIMITED_MS), end:cycleStart(c, LIMITED_MS) + LIMITED_MS }; }
      function limitedSkinAt(c){ return LIMITED_SKINS[((c % LIMITED_SKINS.length) + LIMITED_SKINS.length) % LIMITED_SKINS.length]; }
      function limitedNaviAt(c){ return LIMITED_NAVI[((c % LIMITED_NAVI.length) + LIMITED_NAVI.length) % LIMITED_NAVI.length]; }
      function curLegendCycle(){ return cycleOf(Date.now(), LEGEND_MS); }
      function legendAt(c){ return LEGEND_POOL[((c % LEGEND_POOL.length) + LEGEND_POOL.length) % LEGEND_POOL.length]; }
      function curLegend(){ var c = curLegendCycle(); return { cycle:c, item:legendAt(c), start:cycleStart(c, LEGEND_MS), end:cycleStart(c, LEGEND_MS) + LEGEND_MS }; }
      function lg(){
        if (!save.legend) save.legend = { fragments:0, cycle:-1, owned:{}, justUnlocked:false };
        if (!save.legend.owned) save.legend.owned = {};
        var c = curLegendCycle();
        if (save.legend.cycle !== c){
          // period rolled over: an unfinished legend moves to the past list and a new one starts.
          // Owned legends are kept in legend.owned and never touched.
          save.legend.cycle = c;
          save.legend.fragments = 0;
          persist();
        }
        return save.legend;
      }
      function legendOwnedNow(){ return !!lg().owned[curLegend().item.id]; }
      function periodLineHtml(startMs, span, cdClass){
        return '<span class="period-line"><b>' + periodText(startMs, span) + '</b> ／ おわるまで <b class="' + (cdClass || "") + '">' + countdownText(startMs + span) + '</b></span>';
      }
      function renderLimited(){
        var L = curLimited(), skin = limitedSkinAt(L.cycle), nout = limitedNaviAt(L.cycle), LG = curLegend(), f = lg();
        // ---- SHOP: current limited skin + navigator outfit, periods shown before purchase ----
        var shop = $("limited-shop");
        if (shop){
          var sOwned = !!save.owned[skin.id], sEq = save.skin === skin.id;
          var nOwned = !!nv().owned[nout.id], nEq = nv().outfit === nout.id;
          var warn = daysLeft(L.end) <= 3 ? '<span class="period-warn">⚠ もうすぐ おわり（あと ' + daysLeft(L.end) + ' 日）。おわると 手に入らない</span>' : "";
          shop.innerHTML =
            '<div class="shop-grid">' +
            '<button class="shop-card" id="lim-skin-card"><span class="shop-ic ic-cyan">❄️</span>' +
              '<span class="mid"><span class="tt">いまだけスキン「' + skin.name + '」<span class="limited-badge">いまだけ</span></span>' +
              '<span class="ds">銀ボールの まわりの 輪と 残像の 色が かわる（見た目だけ）。</span>' +
              periodLineHtml(L.start, LIMITED_MS, "js-limited-cd") + warn + (sOwned ? "" : shortfallHtml(skin.price)) + '</span>' +
              '<span class="pr">' + (sOwned ? '<div class="p owned-tag">' + (sEq ? "つかっている" : "もっている") + '</div><div class="b">' + (sEq ? "" : "タップで つかう") + '</div>' : '<div class="p">🪙 ' + skin.price + '</div><div class="b">' + (save.coins >= skin.price ? "コインで 買う" : "コインが たりない") + '</div>') + '</span></button>' +
            '<button class="shop-card" id="lim-navi-card"><span class="shop-ic" style="background:' + nout.color + '">👗</span>' +
              '<span class="mid"><span class="tt">いまだけ ナビ衣装「' + nout.name + '」<span class="limited-badge">いまだけ</span></span>' +
              '<span class="ds">ナビの ミアの 見た目だけが かわる。強さ・ランク戦の ルールは かわらない。</span>' +
              periodLineHtml(L.start, LIMITED_MS, "js-limited-cd") + warn + (nOwned ? "" : shortfallHtml(nout.price)) + '</span>' +
              '<span class="pr">' + (nOwned ? '<div class="p owned-tag">' + (nEq ? "きている" : "もっている") + '</div><div class="b">' + (nEq ? "" : "タップで きる") + '</div>' : '<div class="p">🪙 ' + nout.price + '</div><div class="b">' + (save.coins >= nout.price ? "コインで 買う" : "コインが たりない") + '</div>') + '</span></button>' +
            '</div>' +
            '<p class="friend-reward">◆ 伝説のカケラ（' + f.fragments + ' / ' + FRAGMENTS_NEED + '）は ショップでは 買えない。ふつうの ランで 流れてくる カケラを ひろうだけ（エンドレスでは 出ない）。すすみぐあいと きかんは「あつめたもの」の ページで 見られる。きかんが おわった いまだけアイテムは「まえの いまだけアイテム」へ うつって、手に入らなくなる（もっているものは そのまま つかえる）。</p>';
          var sc = $("lim-skin-card");
          if (sc) sc.addEventListener("click", function(){
            if (curLimited().cycle !== L.cycle){ toast("きかんが かわった。一覧を 新しくするね"); renderAll(); return; }
            if (save.owned[skin.id]){ save.skin = save.skin === skin.id ? "normal" : skin.id; persist(); renderAll(); toast(save.skin === skin.id ? "いまだけスキン「" + skin.name + "」を つけた（見た目だけ）" : "スキンを ノーマルに もどした"); return; }
            if (save.coins < skin.price){ openPackSheet(skin.price - save.coins, "いまだけスキン「" + skin.name + "」"); return; }
            save.coins -= skin.price; trackSpend(skin.price); save.owned[skin.id] = true; save.skin = skin.id; persist(); sfx.buy(); renderAll();
            toast("いまだけスキン「" + skin.name + "」を 買って つけた（見た目だけ・おわっても つかえる）");
          });
          var nc = $("lim-navi-card");
          if (nc) nc.addEventListener("click", function(){
            if (curLimited().cycle !== L.cycle){ toast("きかんが かわった。一覧を 新しくするね"); renderAll(); return; }
            if (nv().owned[nout.id]){ nv().outfit = nout.id; persist(); renderAll(); toast("いまだけ衣装「" + nout.name + "」を きた（見た目だけ）"); return; }
            if (save.coins < nout.price){ openPackSheet(nout.price - save.coins, "いまだけ ナビ衣装「" + nout.name + "」"); return; }
            save.coins -= nout.price; trackSpend(nout.price); nv().owned[nout.id] = true; nv().outfit = nout.id; persist(); sfx.buy(); renderAll();
            toast("いまだけ ナビ衣装「" + nout.name + "」を 買って きた（見た目だけ・おわっても つかえる）");
          });
        }
        // ---- GACHA: periods for every limited item, shown before any pull ----
        var gl = $("gacha-limited");
        if (gl){
          gl.innerHTML = '<section class="gacha-box"><h3 class="gacha-title">⏳ いまだけの アイテム <span class="gacha-tag">引く前に きかんが 見られる</span></h3>' +
            '<p class="gacha-stock">いまだけスキン「' + skin.name + '」／ いまだけ ナビ衣装「' + nout.name + '」<br />' + periodText(L.start, LIMITED_MS) + ' ／ おわるまで <b class="js-limited-cd">' + countdownText(L.end) + '</b><br />買えるのは ショップの「いまだけ」の ところ（この ガチャからは 出ない）。</p>' +
            '<p class="gacha-stock">◆ レジェンド「' + LG.item.name + '」の カケラ（いま ' + f.fragments + ' / ' + FRAGMENTS_NEED + '）<br />' + periodText(LG.start, LEGEND_MS) + ' ／ おわるまで <b class="js-legend-cd">' + countdownText(LG.end) + '</b><br /><b>カケラは ガチャでは 手に入らない。買うことも できない。</b>ふつうの ランで 流れてくるものを ひろうだけ（エンドレスでは 出ない）。</p></section>';
        }
        // ---- MENU sub label: legend goal always one tap away ----
        var ms = $("menu-collection-sub");
        if (ms) ms.innerHTML = legendOwnedNow() ? 'レジェンド ゲットずみ！<span class="nb"> ・</span> いまだけのもの' : '伝説のカケラ ' + f.fragments + " / " + FRAGMENTS_NEED + '<span class="nb"> ・</span> いまだけのもの';
        renderCollection();
      }
      function renderCollection(){
        var main = $("collection-main"); if (!main) return;
        var LG = curLegend(), f = lg(), ownedNow = !!f.owned[LG.item.id];
        var pct = Math.min(100, Math.round(f.fragments / FRAGMENTS_NEED * 100));
        var dl = daysLeft(LG.end);
        if (ownedNow){
          main.innerHTML = '<div class="legend-reveal"><div class="lr-k">◆ レジェンド ゲット ◆</div><div class="lr-t">👑 ' + LG.item.name + '</div><div class="lr-d">' + LG.item.desc + '<br />カケラ ' + FRAGMENTS_NEED + ' / ' + FRAGMENTS_NEED + ' あつまった！ この アイテムは きかんが おわっても ずっと つかえる。</div>' +
            '<span class="period-line" style="color:#e9d8ff"><b style="color:#fff">' + periodText(LG.start, LEGEND_MS) + '</b> の あいだに ゲット</span></div>';
        } else {
          main.innerHTML = '<div class="tier-card" style="margin-top:14px"><span class="mc-tt">◆ レジェンド「' + LG.item.name + '」<span class="limited-badge">いまだけ</span></span>' +
            '<span class="mc-ds">' + LG.item.desc + '。カケラは ふつうの ランで 走っている時に まれに 流れてくる（むらさきピンクの けっしょう＋「カケラ」の 文字）。エンドレスでは 出ない。ガチャや お金では 手に入らない。</span>' +
            '<div class="tier-big" style="margin-top:10px">カケラ <span class="num">' + f.fragments + ' / ' + FRAGMENTS_NEED + '</span></div>' +
            '<div class="frag-bar"><div class="frag-fill" style="width:' + pct + '%"></div></div>' +
            '<span class="mc-ds">あと <b>' + (FRAGMENTS_NEED - f.fragments) + ' 個</b> で レジェンド ゲット。ひろうたびに ふえる（すすみぐあいは じどうで セーブ）。</span>' +
            periodLineHtml(LG.start, LEGEND_MS, "js-legend-cd") +
            (dl <= 7 ? '<div class="period-warn">⚠ おわるまで あと ' + dl + ' 日！ おわると この レジェンドは もう手に入らなくなり、カケラは つぎの レジェンド用に かわる。いそいで あつめよう</div>' : '<span class="mc-ds">きかんの あいだに ' + FRAGMENTS_NEED + ' 個 あつめると ゲット。ゲットしたものは おわっても なくならない。</span>') +
            '</div>';
        }
        var own = $("collection-owned");
        if (own){
          var rows = [];
          Object.keys(SKINS).forEach(function(id){ if (id !== "normal" && save.owned[id]) rows.push("🎨 スキン「" + SKINS[id].name + "」"); });
          NAVI_OUTFITS.concat(LIMITED_NAVI).forEach(function(o){ if (nv().owned[o.id]) rows.push("👗 ナビ衣装「" + o.name + "」"); });
          NAVI_HAIRS.forEach(function(h){ if (save.level >= h.minLv) rows.push("💇 ナビ かみがた「" + h.name + "」（Lv." + h.minLv + " で ゲット）"); });
          Object.keys(f.owned).forEach(function(id){ var it = null; LEGEND_POOL.forEach(function(x){ if (x.id === id) it = x; }); if (it) rows.push("👑 レジェンド「" + it.name + "」"); });
          if (save.pass) rows.push("🎫 パス「広告なし＋ごほうび2倍」");
          if (rk().seasonPass) rows.push("🎫 シーズンパス（見た目だけの とくてん）");
          own.innerHTML = rows.length ? rows.map(function(r){ return '<div class="past-row"><span class="pmid">' + r + '<span class="pds">もっている — きかんが おわっても そのまま つかえる</span></span></div>'; }).join("") : '<div class="past-row"><span class="pmid">まだ 何も あつまって いない<span class="pds">走って 星や カケラを あつめよう</span></span></div>';
        }
        var past = $("collection-past");
        if (past){
          var L = curLimited();
          var ps = limitedSkinAt(L.cycle - 1), pn = limitedNaviAt(L.cycle - 1), pl = legendAt(curLegendCycle() - 1);
          function prow(ic, name, ownedFlag, when){
            return '<div class="past-row"><span>' + ic + '</span><span class="pmid">' + name + '<span class="ended-badge">おわり</span><span class="pds">' + when + ' の いまだけアイテム ／ ' + (ownedFlag ? "もっている — 今も つかえる" : "もっていない — もう手に入らない") + '</span></span></div>';
          }
          past.innerHTML =
            prow("❄️", "いまだけスキン「" + ps.name + "」", !!save.owned[ps.id], fmtD(cycleStart(L.cycle - 1, LIMITED_MS)) + "〜") +
            prow("👗", "いまだけ ナビ衣装「" + pn.name + "」", !!nv().owned[pn.id], fmtD(cycleStart(L.cycle - 1, LIMITED_MS)) + "〜") +
            prow("◆", "レジェンド「" + pl.name + "」", !!f.owned[pl.id], fmtD(cycleStart(curLegendCycle() - 1, LEGEND_MS)) + "〜") +
            '<p class="friend-reward" style="padding:0 14px 12px">つぎの いまだけアイテムは ' + fmtD(L.end) + ' から かわる。かわる前に、このページと ショップで つぎの きかんが 見られる。</p>';
        }
        renderEndlessCollection();
      }

      /* ================= NAVIGATOR "MIA" — HIGH-ENERGY MOE (original character, cosmetic only) ================= */
      var NAVI_OUTFITS = [
        { id:"base",   name:"ベージュの かさねぎカーデ（はじめ）", color:"#d8c3a5", sub:"#ffffff", price:0,   img:"assets/img_4200239613.jpg" },
        { id:"mint",   name:"白トップ＋ピンクリボン",       color:"#ffffff", sub:"#ff8fab", price:300, img:"assets/img_44209990df.jpg" },
        { id:"sakura", name:"こん色ジャケット＋白シャツ",       color:"#2b3a67", sub:"#ffffff", price:500, img:"assets/img_c48dd75a05.jpg" },
        { id:"star",   name:"ピンクパーカー（星マーク）",   color:"#f78fb0", sub:"#ffd23f", price:800, img:"assets/img_75d095d33c.jpg" }
      ];
      /* Additional original navigator characters. Buying one with in-game
         coins and selecting it swaps every non-play navigator appearance —
         home title background, guide, result, gacha, shop — to that
         character's generated illustration. Mia's outfits apply to Mia only;
         an unowned character can never be selected.
         CHARACTER SKILLS: the selected character (= the one on the title)
         also grants ONE small skill in casual runs only — Mia: follow speed
         +5%, Sora: +1 starting shield charge ("バリア1つ"), Hina: magnet
         pull radius +15%. Deliberately tiny ("ちょいアップ"): skills never
         change score totals, star/gate counts, run time or the score MAX,
         and ranked runs ignore them entirely (fixed conditions for all). */
      var NAVI_CHARS = [
        { id:"mia",  name:"ミア", desc:"ピンクの スパイキー＋かさねぎ（はじめの キャラ）。衣装は 上の「ナビの 衣装」で きがえ", price:0,    img:null, skillIc:"⚡", skillLine:"スキル：スピード ちょいアップ" },
        { id:"sora", name:"ソラ", desc:"銀青ボブ＋黒ジャケット＋白シャツ（オリジナル）", price:1200, img:"assets/img_4aa534803d.jpg", skillIc:"🛡️", skillLine:"スキル：はじめから バリア1つ" },
        { id:"hina", name:"ヒナ", desc:"長い茶色の かみ＋ティールの ゆったりセーター＋白シャツ（オリジナル）", price:1500, img:"assets/img_4c410f0401.jpg", skillIc:"🧲", skillLine:"スキル：星を ひきよせる はんい ちょい広い" }
      ];
      var NAVI_HAIRS = [
        { id:"bob",  name:"スパイキーショート（基本）", minLv:1, color:"#ff4f92" },
        { id:"twin", name:"スパイキー・ツイン",         minLv:3, color:"#ff5ca8" },
        { id:"long", name:"スパイキー・セミロング",     minLv:5, color:"#f2438c" }
      ];
      var NAVI_GACHA_COST = 150;
      var NAVI_GACHA_POOL = [
        { id:"mint",   pct:35, dup:150 },
        { id:"sakura", pct:30, dup:200 },
        { id:"star",   pct:20, dup:300 },
        { id:"coin",   pct:15, dup:0 }
      ];
      var naviDismissed = {};
      var naviGachaMsg = "";
      function nv(){
        if (!save.navi) save.navi = { outfit:"base", hair:"bob", owned:{ base:true } };
        if (!save.navi.owned) save.navi.owned = { base:true };
        if (!save.navi.char) save.navi.char = "mia";
        if (!save.navi.chars) save.navi.chars = { mia:true };
        if (!save.navi.variantOwned) save.navi.variantOwned = {};
        if (save.navi.variant === undefined) save.navi.variant = null;
        return save.navi;
      }
      function naviChar(){ var n = nv(); for (var i = 0; i < NAVI_CHARS.length; i++) if (NAVI_CHARS[i].id === n.char) return NAVI_CHARS[i]; return NAVI_CHARS[0]; }
      function naviName(){ return naviChar().name; }
      function naviImg(){
        var c = naviChar();
        if (c.img) return c.img;
        var n = nv();
        if (n.variant){ var v = variantById(n.variant); if (v && v.base === n.outfit) return baseOutfitImg(v.base); }
        var o = naviOutfit();
        return o.img || "assets/img_4200239613.jpg";
      }
      function naviOutfit(){ var n = nv(); var all = NAVI_OUTFITS.concat(LIMITED_NAVI); for (var i = 0; i < all.length; i++) if (all[i].id === n.outfit) return all[i]; return NAVI_OUTFITS[0]; }
      function naviHair(){ var n = nv(); for (var i = 0; i < NAVI_HAIRS.length; i++) if (NAVI_HAIRS[i].id === n.hair) return NAVI_HAIRS[i]; return NAVI_HAIRS[0]; }
      function naviSvg(expr){
        // Navigator illustration: the generated art of the currently
        // selected character (Mia wears her equipped outfit), shipped as
        // local assets under assets/. Used for every non-play appearance
        // (guide / result / level-up / gacha / shop); the navigator never
        // appears during a run. "expr" is accepted for call-site
        // compatibility and intentionally unused.
        return '<img class="mia-photo" src="' + naviImg() + '" alt="ナビゲーターの' + naviName() + '（オリジナルイラスト）" />';
      }
      var naviCards = {};   // key -> { lines:[...], sig, idx } for tap-to-advance bubbles
      function naviCardHtml(key, lines, expr){
        if (naviDismissed[key]) return "";
        var arr = Array.isArray(lines) ? lines : [lines];
        var sig = arr.join("\n");
        if (!naviCards[key] || naviCards[key].sig !== sig) naviCards[key] = { lines: arr, sig: sig, idx: 0 };
        var c = naviCards[key];
        var hasNext = c.idx < c.lines.length - 1;
        return '<div class="navi-card"><div class="navi-art">' + naviSvg(expr) + '</div>' +
          '<div class="navi-bubble"' + (hasNext ? ' data-navi-advance="' + key + '" role="button" aria-label="タップで次のセリフへ"' : '') + '>' +
          '<span class="navi-name">' + naviName() + '</span><p class="navi-line">' + c.lines[c.idx] + '</p>' +
          (hasNext ? '<span class="navi-next">▼ タップで次へ（' + (c.idx + 1) + ' / ' + c.lines.length + '）</span>' : '') +
          '</div><button class="navi-dismiss" data-navi-dismiss="' + key + '" aria-label="ナビの吹き出しを閉じる"><span class="dx">✕</span>閉じる</button></div>';
      }
      function renderNavi(){
        var n = nv();
        // colour variants (outfit variant + endless colour) drive one CSS
        // variable that recolours every navigator appearance at once
        var appEl = document.getElementById("app");
        if (appEl){
          var fparts = [];
          if (!naviChar().img && n.variant){ var vv = variantById(n.variant); if (vv && vv.base === n.outfit) fparts.push(vv.filter); }
          var eNv = en();
          if (eNv.items.outfit && eNv.outfitOn) fparts.push("hue-rotate(140deg) saturate(1.55)");
          appEl.style.setProperty("--navi-filter", fparts.length ? fparts.join(" ") : "none");
        }
        // home: the selected character / equipped outfit illustration IS
        // the title background; the growth strip under it shows coins,
        // skin & character collection progress, and the next purchase goal.
        var bgImg = $("home-bg-img");
        if (bgImg && bgImg.getAttribute("src") !== naviImg()) bgImg.src = naviImg();
        var gc = $("home-growth-coins"); if (gc) gc.textContent = save.coins;
        var ownedSkins = NAVI_OUTFITS.filter(function(o){ return !!n.owned[o.id]; }).length;
        var gsEl = $("home-growth-skins"); if (gsEl) gsEl.textContent = ownedSkins + " / " + NAVI_OUTFITS.length;
        var ownedChars = NAVI_CHARS.filter(function(c){ return !!n.chars[c.id]; }).length;
        var ghEl = $("home-growth-chars"); if (ghEl) ghEl.textContent = ownedChars + " / " + NAVI_CHARS.length;
        var gnEl = $("home-growth-next");
        if (gnEl){
          var next = null;
          NAVI_OUTFITS.forEach(function(o){ if (!n.owned[o.id] && (!next || o.price < next.price)) next = { name:"スキン「" + o.name + "」", price:o.price }; });
          NAVI_CHARS.forEach(function(c){ if (!n.chars[c.id] && (!next || c.price < next.price)) next = { name:"キャラ「" + c.name + "」", price:c.price }; });
          gnEl.innerHTML = next
            ? (save.coins >= next.price
                ? "つぎは <b>" + next.name + "</b>（🪙 " + next.price + "）が 買える！ 下のボタンで ショップへ"
                : "つぎは <b>" + next.name + "</b>（🪙 " + next.price + "）— あと <b>" + (next.price - save.coins) + " コイン</b>")
            : "スキンと キャラは ぜんぶ あつまった！ 好きな 見た目で あそぼう";
        }
        var gg = $("gacha-navi");
        if (gg) gg.innerHTML = naviCardHtml("gacha", naviGachaMsg
          ? [naviGachaMsg, "かくりつは それぞれの ガチャの 表に ぜんぶ 出してあるよ。かぶったら コインに かわるよ"]
          : ["ガチャは かくりつを ぜんぶ 見せてるよ。伝説のカケラは ガチャじゃ 出ないからね", "カケラは 走って ひろうだけだよ。何回も 走って レジェンドを ゲットしよう"], "happy");
        var nb = $("navi-gacha-balance");
        if (nb) nb.textContent = "1回（150）： " + balText(150) + " ／ 10回（1,500）： " + balText(1500);
        var pv = $("navi-preview");
        if (pv) pv.innerHTML = naviCardHtml("shop", ["衣装と かみがたは ぜんぶ 見た目だけだよ", "強さも ランク戦の ルールも かわらないから、安心して えらんでね"], "shy");
        var grid = $("navi-grid");
        if (grid){
          grid.innerHTML = NAVI_OUTFITS.map(function(o){
            var owned = !!n.owned[o.id], eq = n.outfit === o.id;
            var right = owned
              ? '<div class="p owned-tag">' + (eq ? "きている" : "もっている") + '</div><div class="b">' + (eq ? "" : "タップで きる") + '</div>'
              : '<div class="p">🪙 ' + o.price + '</div><div class="b">' + (save.coins >= o.price ? "コインで 買う" : "コインが たりない") + '</div>';
            return '<button class="shop-card" data-navi-outfit="' + o.id + '"><span class="shop-ic navi-thumb"><img src="' + o.img + '" alt="" /></span>' +
              '<span class="mid"><span class="tt">ナビ衣装「' + o.name + '」</span><span class="ds">ミアの 衣装。きると タイトル画面の ミアも この 衣装に なる。見た目だけで、強さ・スコアは かわらない。</span>' + (owned ? "" : shortfallHtml(o.price)) + '</span>' +
              '<span class="pr">' + right + '</span></button>';
          }).join("");
          Array.prototype.forEach.call(grid.querySelectorAll("[data-navi-outfit]"), function(b){
            b.addEventListener("click", function(){
              var id = b.getAttribute("data-navi-outfit");
              var o = NAVI_OUTFITS.find(function(x){ return x.id === id; });
              if (nv().owned[id]){ nv().outfit = id; nv().variant = null; persist(); renderAll(); toast("ミアの 衣装を「" + o.name + "」に した（見た目だけ）"); return; }
              if (save.coins < o.price){ openPackSheet(o.price - save.coins, "ナビ衣装「" + o.name + "」"); return; }
              save.coins -= o.price; trackSpend(o.price); stats().coinsSinceOutfit = 0; stats().runsSinceOutfit = 0; nv().owned[id] = true; nv().outfit = id; nv().variant = null; persist(); sfx.buy(); renderAll();
              toast("ナビ衣装「" + o.name + "」を 買って きた（見た目だけ）");
            });
          });
        }
        var vg = $("navi-variant-grid");
        if (vg){
          vg.innerHTML = OUTFIT_VARIANTS.map(function(v){
            var owned = !!n.variantOwned[v.id], eq = n.variant === v.id && n.outfit === v.base;
            var right = owned
              ? '<div class="p owned-tag">' + (eq ? "きている" : "もっている") + '</div><div class="b">' + (eq ? "タップで はずす" : "タップで きる") + '</div>'
              : '<div class="p">🪙 ' + v.price + '</div><div class="b">' + (save.coins >= v.price ? "コインで 買う" : "コインが たりない") + '</div>';
            return '<button class="shop-card" data-navi-variant="' + v.id + '"><span class="shop-ic navi-thumb"><img src="' + baseOutfitImg(v.base) + '" alt="" style="filter:' + v.filter + '" /></span>' +
              '<span class="mid"><span class="tt">色ちがい「' + v.name + '」</span><span class="ds">同じ イラストの 色ちがい（カラーバリエーション）。ミアが その衣装を きている時に タイトルや ナビに 出る。見た目だけで、強さ・スコアは かわらない。</span>' + (owned ? "" : shortfallHtml(v.price)) + '</span>' +
              '<span class="pr">' + right + '</span></button>';
          }).join("");
          Array.prototype.forEach.call(vg.querySelectorAll("[data-navi-variant]"), function(b){
            b.addEventListener("click", function(){
              var id = b.getAttribute("data-navi-variant");
              var v = variantById(id);
              if (nv().variantOwned[id]){
                if (nv().variant === id && nv().outfit === v.base){ nv().variant = null; toast("色ちがいを はずした"); }
                else { nv().outfit = v.base; nv().variant = id; toast("色ちがい「" + v.name + "」を きた（見た目だけ）"); }
                persist(); renderAll(); return;
              }
              if (save.coins < v.price){ openPackSheet(v.price - save.coins, "色ちがい「" + v.name + "」"); return; }
              save.coins -= v.price; trackSpend(v.price); stats().coinsSinceOutfit = 0; stats().runsSinceOutfit = 0;
              nv().variantOwned[id] = true; nv().outfit = v.base; nv().variant = id; persist(); sfx.buy(); renderAll();
              toast("色ちがい「" + v.name + "」を 買って きた（見た目だけ）");
            });
          });
        }
        var cg = $("navi-char-grid");
        if (cg){
          cg.innerHTML = NAVI_CHARS.map(function(c){
            var owned = !!n.chars[c.id], sel = n.char === c.id;
            var thumb = c.img || (naviOutfit().img || "assets/img_4200239613.jpg");
            var right = owned
              ? '<div class="p owned-tag">' + (sel ? "えらんでいる" : "もっている") + '</div><div class="b">' + (sel ? "" : "タップで えらぶ") + '</div>'
              : '<div class="p">🪙 ' + c.price + '</div><div class="b">' + (save.coins >= c.price ? "コインで 買う" : "コインが たりない") + '</div>';
            return '<button class="shop-card" data-navi-char="' + c.id + '"><span class="shop-ic navi-thumb"><img src="' + thumb + '" alt="" /></span>' +
              '<span class="mid"><span class="tt">キャラ「' + c.name + '」</span><span class="ds">' + c.desc + '。' + c.skillIc + ' ' + c.skillLine + '。えらんで タイトルに 出すと、いつもの ランで スキルが つかえる。ランク戦では つかわれない。</span>' + (owned ? "" : shortfallHtml(c.price)) + '</span>' +
              '<span class="pr">' + right + '</span></button>';
          }).join("");
          Array.prototype.forEach.call(cg.querySelectorAll("[data-navi-char]"), function(b){
            b.addEventListener("click", function(){
              var id = b.getAttribute("data-navi-char");
              var c = NAVI_CHARS.find(function(x){ return x.id === id; });
              if (nv().chars[id]){ nv().char = id; persist(); renderAll(); toast("ナビを「" + c.name + "」に した（タイトルにも 出る）"); return; }
              if (save.coins < c.price){ openPackSheet(c.price - save.coins, "キャラ「" + c.name + "」"); return; }
              save.coins -= c.price; trackSpend(c.price); stats().coinsSinceOutfit = 0; stats().runsSinceOutfit = 0; nv().chars[id] = true; nv().char = id; persist(); sfx.buy(); renderAll();
              toast("キャラ「" + c.name + "」を 買って えらんだ");
            });
          });
        }
        var hr = $("navi-hair-row");
        if (hr){
          hr.innerHTML = '<div class="navi-hair-btns">' + NAVI_HAIRS.map(function(h){
            var unlocked = save.level >= h.minLv, on = n.hair === h.id;
            return '<button class="navi-hair-btn' + (on ? " on" : "") + '" data-navi-hair="' + h.id + '"' + (unlocked ? "" : " disabled") + '>' + h.name + '<br /><small>' + (on ? "つかっている" : unlocked ? "タップで かえる" : "Lv." + h.minLv + " で ゲット（いま Lv." + save.level + "）") + '</small></button>';
          }).join("") + '</div>';
          Array.prototype.forEach.call(hr.querySelectorAll("[data-navi-hair]"), function(b){
            b.addEventListener("click", function(){
              var id = b.getAttribute("data-navi-hair");
              var h = NAVI_HAIRS.find(function(x){ return x.id === id; });
              if (save.level < h.minLv) return;
              nv().hair = id; persist(); renderAll(); toast("ミアの かみがたを「" + h.name + "」に した（見た目だけ）");
            });
          });
        }
      }

      /* ================= ENDLESS / RECORDS / SEASON / ALBUM ================= */
      var ENDLESS_ITEMS = {
        comet:   { ic:"☄️", name:"コメット",       kind:"スキン", price:25, desc:"銀ボールの まわりの 輪と 残像が 水色に かわり、コメットの しっぽが 出る（見た目だけ）" },
        sparkle: { ic:"✨", name:"星のきらめき",   kind:"こんせき", price:40, desc:"ボールの 通った あとに 星が きらめく（見た目だけ）" },
        outfit:  { ic:"👗", name:"エンドレス・カラー", kind:"衣装の色ちがい", price:60, desc:"いま えらんでいる キャラの 衣装の 色ちがい（見た目だけ）。タイトルにも 出る" }
      };
      function endlessShortfallHtml(price){
        var bal = en().coins || 0;
        if (bal >= price) return "";
        var short = price - bal;
        var pct = Math.floor(bal / price * 100);
        return '<span class="prog-wrap"><span class="prog-bar"><span class="prog-fill" style="display:block;width:' + pct + '%"></span></span>' +
          '<span class="prog-tx">あと ' + short + ' まいで 買える（もっている ⬡ ' + bal + ' / ' + price + '）　エンドレスで あつめよう</span></span>';
      }
      var ENDLESS_COIN_CAP = 300, ENDLESS_MIN_BONUS = 300;
      function en(){
        if (!save.endless) save.endless = { bestTime:0, bestScore:0, coins:0, items:{ comet:false, sparkle:false, outfit:false }, outfitOn:false };
        if (!save.endless.items) save.endless.items = { comet:false, sparkle:false, outfit:false };
        if (save.endless.coins === undefined || save.endless.coins === null) save.endless.coins = 0;
        return save.endless;
      }
      function fmtElapsed(sec){
        sec = Math.max(0, Math.floor(sec));
        var m = Math.floor(sec / 60), s = sec % 60;
        return m + ":" + (s < 10 ? "0" : "") + s;
      }
      /* Endless items are PURCHASE-ONLY now (shop, エンドレスコイン only).
         The old 90s / 12,000pt / 180s threshold unlocks are removed.
         Items already owned under the old system stay owned — en().items
         is never cleared here or anywhere else. */
      function checkEndlessItems(){ /* purchase-only: nothing auto-grants in a run */ }
      /* ---- local-only run records (never sent anywhere) ---- */
      function stats(){
        if (!save.stats) save.stats = { runs:[], totalRuns:0, totalCoinsEarned:0, totalCoinsSpent:0, resultsShown:0, restarts:0, firstDay:"", days:{}, coinsSinceOutfit:0, runsSinceOutfit:0, lastScore:{ casual:-1, endless:-1, ranked:-1 }, galsUsed:{}, lastRunDate:"", firstClear:false };
        var s = save.stats;
        if (!s.runs) s.runs = []; if (!s.days) s.days = {}; if (!s.galsUsed) s.galsUsed = {};
        if (!s.lastScore) s.lastScore = { casual:-1, endless:-1, ranked:-1 };
        return s;
      }
      function trackSpend(n){ if (n > 0) stats().totalCoinsSpent += n; }
      function recordRun(rec){
        var s = stats();
        s.runs.push(rec);
        if (s.runs.length > 200) s.runs.splice(0, s.runs.length - 200);
        s.totalRuns++;
        s.totalCoinsEarned += rec.coins;
        s.coinsSinceOutfit += rec.coins; s.runsSinceOutfit++;
        if (!s.firstDay) s.firstDay = rec.date;
        s.days[rec.date] = (s.days[rec.date] || 0) + 1;
        if (rec.gal) s.galsUsed[rec.gal] = true;
        if (rec.cleared) s.firstClear = true;
      }
      function trails(){ if (!save.trails) save.trails = { sakura:false, season:false, sparkle:false, equip:"none" }; if (save.trails.sparkle === undefined) save.trails.sparkle = false; return save.trails; }
      /* ---- outfit colour variants (CSS filter on the same illustration) ---- */
      var OUTFIT_VARIANTS = [
        { id:"base_v",   base:"base",   name:"ベージュの かさねぎカーデ（色ちがい）", filter:"hue-rotate(150deg) saturate(1.35)", price:150 },
        { id:"mint_v",   base:"mint",   name:"白トップ＋ピンクリボン（色ちがい）",   filter:"hue-rotate(-55deg) saturate(1.4)",  price:150 },
        { id:"sakura_v", base:"sakura", name:"こん色ジャケット＋白シャツ（色ちがい）", filter:"hue-rotate(95deg) saturate(1.3)",   price:150 },
        { id:"star_v",   base:"star",   name:"ピンクパーカー（色ちがい）",           filter:"hue-rotate(205deg) saturate(1.35)", price:150 }
      ];
      function variantById(id){ for (var i = 0; i < OUTFIT_VARIANTS.length; i++) if (OUTFIT_VARIANTS[i].id === id) return OUTFIT_VARIANTS[i]; return null; }
      function variantName(id){ var v = variantById(id); return v ? v.name : id; }
      function baseOutfitImg(baseId){ var o = null; NAVI_OUTFITS.forEach(function(x){ if (x.id === baseId) o = x; }); return o ? (o.img || "assets/img_4200239613.jpg") : "assets/img_4200239613.jpg"; }
      /* ---- season track: 4 weeks, 20 tiers, points from runs / missions ---- */
      var SEASON_MS = 28 * 24 * 3600 * 1000;
      var SEASON_TIER_PTS = [0,20,50,90,140,200,270,350,440,540,650,770,900,1040,1190,1350,1520,1700,1890,2090];
      var SEASON_FREE = [
        {t:"coins",n:30},{t:"coins",n:40},{t:"coins",n:50},{t:"coins",n:60},{t:"life"},
        {t:"coins",n:70},{t:"variant",id:"base_v"},{t:"coins",n:80},{t:"coins",n:90},{t:"coins",n:100},
        {t:"coins",n:110},{t:"life"},{t:"coins",n:120},{t:"variant",id:"star_v"},{t:"coins",n:130},
        {t:"coins",n:140},{t:"coins",n:150},{t:"coins",n:160},{t:"coins",n:180},{t:"coins",n:200}
      ];
      var SEASON_PAID = [
        {t:"coins",n:30},{t:"coins",n:40},{t:"coins",n:50},{t:"variant",id:"mint_v"},{t:"coins",n:60},
        {t:"coins",n:80},{t:"coins",n:90},{t:"coins",n:100},{t:"variant",id:"sakura_v"},{t:"coins",n:110},
        {t:"coins",n:120},{t:"coins",n:130},{t:"coins",n:140},{t:"coins",n:150},{t:"coins",n:160},
        {t:"coins",n:170},{t:"trail",id:"season"},{t:"coins",n:180},{t:"coins",n:190},{t:"coins",n:220}
      ];
      function seasonState(){
        if (!save.season) save.season = { key:"", points:0, paid:false, granted:0, paidGranted:0, maxTier:0 };
        return save.season;
      }
      function curSeason(){ var c = cycleOf(Date.now(), SEASON_MS); return { cycle:c, start:cycleStart(c, SEASON_MS), end:cycleStart(c, SEASON_MS) + SEASON_MS }; }
      function ensureSeason(){
        var S = seasonState(), cur = curSeason(), key = "s" + cur.cycle;
        if (S.key !== key){
          var conv = (S.key && S.points > 0) ? Math.floor(S.points / 10) : 0;
          if (conv > 0){
            save.coins += conv;
            setTimeout(function(){ toast("まえの シーズンの ポイントが コイン " + conv + " に かわって 入ったよ"); }, 900);
          }
          S.key = key; S.points = 0; S.paid = false; S.granted = 0; S.paidGranted = 0; S.maxTier = 0;
          persist();
        }
        return S;
      }
      function seasonTier(points){ var t = 0; for (var i = 0; i < SEASON_TIER_PTS.length; i++) if (points >= SEASON_TIER_PTS[i]) t = i + 1; return t; }
      var seasonTierJustUp = 0;
      function applySeasonReward(rw){
        if (!rw) return;
        if (rw.t === "coins") save.coins += rw.n;
        else if (rw.t === "life"){ refreshLives(); save.lives = LIVES_MAX; save.livesTs = Date.now(); }
        else if (rw.t === "variant"){ if (!nv().variantOwned[rw.id]) nv().variantOwned[rw.id] = true; else save.coins += 150; }
        else if (rw.t === "trail"){ if (!trails().season) trails().season = true; else save.coins += 150; }
      }
      function grantSeasonRewards(){
        var S = ensureSeason(), tier = seasonTier(S.points);
        if (tier > (S.maxTier || 0)) S.maxTier = tier;
        while ((S.granted || 0) < tier){ applySeasonReward(SEASON_FREE[S.granted]); S.granted++; seasonTierJustUp = S.granted; }
        if (S.paid){ while ((S.paidGranted || 0) < tier){ applySeasonReward(SEASON_PAID[S.paidGranted]); S.paidGranted++; } }
        persist();
      }
      function addSeasonPoints(n){ var S = ensureSeason(); S.points += n; grantSeasonRewards(); }
      function rewardText(rw){
        if (!rw) return "—";
        if (rw.t === "coins") return "コイン +" + rw.n;
        if (rw.t === "life") return "ライフ ぜんぶ もどる";
        if (rw.t === "variant") return "色ちがい衣装「" + variantName(rw.id) + "」";
        if (rw.t === "trail") return "こんせき「シーズンのきらめき」";
        return "—";
      }
      function buySeasonPaid(){
        if (publicMode()) return;   // こうかい版モード: 有料トラックの購入画面は 出さない
        var S = ensureSeason(), cur = curSeason();
        if (S.paid){ toast("ペイドトラックは もう つかっている"); return; }
        openSheet({
          ic:"🎫", title:"シーズン ペイドトラック（モック）",
          desc:"シーズン " + (cur.cycle + 1) + "（" + periodText(cur.start, SEASON_MS) + "、おわるまで " + daysLeft(cur.end) + " 日）の ペイド ごほうびが もらえる。ぜんぶ 見た目だけ（色ちがい衣装・こんせき・コイン）。強さ・スコア・ランクは かわらない。ティアを 買うことは できない。",
          price:"¥480", buyLabel:"ペイドトラックを 買ったことに する",
          onBuy: function(){
            S.paid = true; grantSeasonRewards(); renderAll();
            toast("ペイドトラックが つかえるように なった（モック）— ごほうびは 見た目だけ");
          }
        });
      }
      function renderSeasonPage(){
        var main = $("season-main"); if (!main) return;
        var tnote = $("season-track-note");
        if (tnote) tnote.textContent = publicMode() ? "フリーの ごほうびだけ" : "フリーは 全員 ・ ペイドは モック購入した人だけ";
        var fnote = $("season-foot-note");
        if (fnote) fnote.textContent = publicMode()
          ? "シーズンポイントの ルール： 1回 走る = 10pt ／ ミッション クリア = 20pt ／ きょうの チャレンジ クリア = 30pt。シーズンが おわると、のこった ポイントは 10pt = 1コインに かわって 入る（なくならない）。もらった 見た目の アイテムは シーズンが おわっても ずっと つかえる。ごほうびは ぜんぶ 見た目だけ。強さ・スコア・ランク戦の ルールは かわらない。"
          : "シーズンポイントの ルール： 1回 走る = 10pt ／ ミッション クリア = 20pt ／ きょうの チャレンジ クリア = 30pt。シーズンが おわると、のこった ポイントは 10pt = 1コインに かわって 入る（なくならない）。もらった 見た目の アイテムは シーズンが おわっても ずっと つかえる。ペイドの ごほうびも ぜんぶ 見た目だけ。強さ・スコア・ランク戦の ルールは かわらない。";
        var S = ensureSeason(), cur = curSeason(), tier = seasonTier(S.points);
        var nextPts = tier < 20 ? SEASON_TIER_PTS[tier] : null;
        var pct = nextPts ? Math.min(100, Math.floor(S.points / nextPts * 100)) : 100;
        main.innerHTML = '<div class="tier-card" style="margin-top:14px"><span class="mc-tt">🌸 シーズン ' + (cur.cycle + 1) + '</span>' +
          '<span class="mc-ds">' + periodText(cur.start, SEASON_MS) + ' ／ おわるまで <b>' + daysLeft(cur.end) + ' 日</b></span>' +
          '<div class="tier-big" style="margin-top:8px">ティア <span class="num">' + tier + '</span> / 20 ・ <span class="num">' + S.points.toLocaleString() + '</span> pt</div>' +
          '<div class="frag-bar"><div class="frag-fill" style="width:' + pct + '%"></div></div>' +
          '<span class="mc-ds">' + (nextPts ? 'つぎの ティアまで あと <b>' + (nextPts - S.points).toLocaleString() + ' pt</b>（1回 走る = 10pt）' : 'ティアは ぜんぶ たっせい！ おつかれさま') + '</span>' +
          (publicMode() ? "" : (S.paid ? '<span class="mc-ds">ペイドトラック： つかっている（モック）</span>' : '<button class="season-pass-btn" id="btn-season-paid">🎫 ペイドトラック ¥480（モック）—<br />見た目だけの ごほうびが ふえる</button>')) +
          '</div>';
        var pb = $("btn-season-paid"); if (pb) pb.addEventListener("click", buySeasonPaid);
        var rows = "";
        for (var i = 0; i < 20; i++){
          var reached = tier > i;
          rows += '<div class="season-row' + (reached ? " reached" : "") + '"><span class="st-tier">ティア ' + (i + 1) + '<br /><span style="font-size:11px;color:var(--ink-dim)">' + SEASON_TIER_PTS[i] + ' pt</span></span><span class="st-mid">' +
            '<span class="st-rw"><span class="tag tag-free">フリー</span>' + rewardText(SEASON_FREE[i]) + '</span>' +
            (publicMode() ? "" : '<span class="st-rw"><span class="tag tag-paid">ペイド</span>' + rewardText(SEASON_PAID[i]) + '</span>') + '</span>' +
            '<span class="st-state' + (reached ? " got" : "") + '">' + (reached ? "もらった ✓" : "あと " + (SEASON_TIER_PTS[i] - S.points) + " pt") + '</span></div>';
        }
        var tel = $("season-tiers"); if (tel) tel.innerHTML = rows;
      }
      /* ---- memory album: earned by actions only, display only, no completion reward ---- */
      var ALBUM_CARDS = [
        { id:"first60",    ic:"⏰", t:"はじめての 完走",   d:"60秒 走りきる",              line:"やったね！ 1分間 にげきれた！" },
        { id:"endless90",  ic:"🏃", t:"エンドレス 90秒",   d:"エンドレスで 90秒 たえる",    line:"90秒！ よく たえたね。エンドレスコインも たまったかな" },
        { id:"endless180", ic:"🌟", t:"エンドレス 180秒",  d:"エンドレスで 180秒 たえる",   line:"3分間… ほんとうに すごい。おつかれさま！" },
        { id:"days7",      ic:"📅", t:"7日 あそんだ",      d:"7つの 日に あそぶ",          line:"何日も 来てくれて ありがとう" },
        { id:"allgals",    ic:"👧", t:"3人 全員と 走った",  d:"ミア・ソラ・ヒナ 全員で 走る", line:"みんなで 走ると たのしいね" },
        { id:"near100",    ic:"💨", t:"ニアミス 100回",    d:"ニアミス ぜんぶで 100回",     line:"ギリギリを せめるの、じょうずに なったね" },
        { id:"gold10",     ic:"⭐", t:"金星 10個",         d:"金星 ぜんぶで 10個",         line:"金星を 見つける 目が できてきたね" },
        { id:"score6000",  ic:"🏆", t:"スコア 6,000",      d:"1回で 6,000点",              line:"6,000点！ 記録こうしんの 音、気持ちいいよね" },
        { id:"combo12",    ic:"🔥", t:"12コンボ",          d:"1回で 12コンボ",             line:"コンボが つながると わくわくするね" },
        { id:"runs50",     ic:"👟", t:"50回 走った",       d:"ぜんぶで 50回 走る",          line:"50回！ もう ベテランだね" },
        { id:"season5",    ic:"🌸", t:"シーズン ティア5",   d:"シーズンで ティア5に なる",   line:"シーズンも すすんでる！ その ちょうし" },
        { id:"level5",     ic:"📈", t:"レベル 5",          d:"レベル 5に なる",            line:"レベル5！ つよく なったね" }
      ];
      function albumState(){ if (!save.album) save.album = {}; return save.album; }
      function checkAlbum(){
        var A = albumState(), s = stats(), got = [];
        function give(id){ if (!A[id]){ A[id] = true; got.push(id); } }
        if (s.firstClear) give("first60");
        if (en().bestTime >= 90) give("endless90");
        if (en().bestTime >= 180) give("endless180");
        if (Object.keys(s.days).length >= 7) give("days7");
        if (s.galsUsed.mia && s.galsUsed.sora && s.galsUsed.hina) give("allgals");
        if (save.totNear >= 100) give("near100");
        if (save.totGold >= 10) give("gold10");
        if (save.best >= 6000 || en().bestScore >= 6000) give("score6000");
        if ((save.totMaxCombo || 0) >= 12) give("combo12");
        if (s.totalRuns >= 50) give("runs50");
        if ((seasonState().maxTier || 0) >= 5) give("season5");
        if (save.level >= 5) give("level5");
        if (got.length) persist();
        return got;
      }
      /* ---- achievements: display only, no coins / no power ---- */
      var ACHIEVEMENTS = [
        { ic:"⏰", t:"はじめての 完走",   cur:function(){ return stats().firstClear ? 1 : 0; }, target:1, unit:"回" },
        { ic:"👟", t:"10回 走る",         cur:function(){ return stats().totalRuns; }, target:10, unit:"回" },
        { ic:"👟", t:"50回 走る",         cur:function(){ return stats().totalRuns; }, target:50, unit:"回" },
        { ic:"💨", t:"ニアミス 100回",     cur:function(){ return save.totNear; }, target:100, unit:"回" },
        { ic:"💨", t:"ニアミス 500回",     cur:function(){ return save.totNear; }, target:500, unit:"回" },
        { ic:"⭐", t:"星 500個",           cur:function(){ return save.totStars; }, target:500, unit:"個" },
        { ic:"🌟", t:"金星 20個",          cur:function(){ return save.totGold; }, target:20, unit:"個" },
        { ic:"🏆", t:"スコア 5,000",       cur:function(){ return save.best; }, target:5000, unit:"点" },
        { ic:"🏆", t:"スコア 8,000",       cur:function(){ return save.best; }, target:8000, unit:"点" },
        { ic:"🏃", t:"エンドレス 90秒",     cur:function(){ return Math.floor(en().bestTime); }, target:90, unit:"秒" },
        { ic:"🏃", t:"エンドレス 120秒",    cur:function(){ return Math.floor(en().bestTime); }, target:120, unit:"秒" },
        { ic:"🏃", t:"エンドレス 180秒",    cur:function(){ return Math.floor(en().bestTime); }, target:180, unit:"秒" },
        { ic:"📅", t:"7日 あそぶ",         cur:function(){ return Object.keys(stats().days).length; }, target:7, unit:"日" },
        { ic:"🔥", t:"コンボ 15",          cur:function(){ return save.totMaxCombo || 0; }, target:15, unit:"" },
        { ic:"📈", t:"レベル 5",           cur:function(){ return save.level; }, target:5, unit:"" }
      ];
      function renderRecords(){
        var main = $("records-main"); if (!main) return;
        var s = stats(); ensureSeason(); checkAlbum();
        var hist = s.runs;
        var normalRuns = hist.filter(function(r){ return r.mode === "casual"; });
        var clears = normalRuns.filter(function(r){ return r.cleared; }).length;
        var clearRate = normalRuns.length ? Math.round(clears / normalRuns.length * 100) : 0;
        var deaths = hist.filter(function(r){ return r.crashed; });
        var avgDeath = deaths.length ? Math.round(deaths.reduce(function(a, r){ return a + r.secs; }, 0) / deaths.length) : 0;
        var daysPlayed = Object.keys(s.days).length;
        var today = dateKey(new Date());
        var yd = new Date(); yd.setDate(yd.getDate() - 1); var yest = dateKey(yd);
        var last7 = 0; for (var di = 0; di < 7; di++){ var dd = new Date(); dd.setDate(dd.getDate() - di); if (s.days[dateKey(dd)]) last7++; }
        var restartRate = s.resultsShown ? Math.round(s.restarts / s.resultsShown * 100) : 0;
        var runsPerDay = daysPlayed ? (s.totalRuns / daysPlayed).toFixed(1) : "0";
        var coinLine;
        if (s.coinsSinceOutfit >= 300) coinLine = "さいごに 衣装・キャラを 買ってから 🪙 " + s.coinsSinceOutfit.toLocaleString() + " かせいだ（300 たまった！）";
        else if (s.runsSinceOutfit > 0 && s.coinsSinceOutfit > 0){
          var per = s.coinsSinceOutfit / s.runsSinceOutfit;
          coinLine = "さいごに 衣装・キャラを 買ってから " + s.runsSinceOutfit + "回 走って 🪙 " + s.coinsSinceOutfit.toLocaleString() + " かせいだ。300まで あと " + (300 - s.coinsSinceOutfit) + " コイン（いまの ペースだと 約 " + Math.ceil((300 - s.coinsSinceOutfit) / per) + " 回くらい）";
        } else coinLine = "さいごに 衣装・キャラを 買ってから、まだ 走っていない";
        function rl(k, v){ return '<div class="ach-row"><span class="amid">' + k + '</span><span class="ach-prog">' + v + '</span></div>'; }
        main.innerHTML =
          '<section class="block" style="margin-top:14px"><div class="block-head"><h2>あそんだ 数字</h2><span class="note">さいきん 200回の きろくから</span></div><div class="rank-list">' +
          rl("ぜんぶで 走った回数", s.totalRuns + " 回") +
          rl("60秒 完走できた わりあい（ふつうの ラン）", normalRuns.length ? clearRate + " ％（" + clears + " / " + normalRuns.length + " 回）" : "まだ ない") +
          rl("ぶつかった時の へいきん秒数", deaths.length ? "約 " + avgDeath + " 秒" : "まだ ない") +
          rl("もう1回 ボタンを おした わりあい", s.resultsShown ? restartRate + " ％" : "まだ ない") +
          rl("1日に へいきん 何回 走るか", runsPerDay + " 回") +
          '</div></section>' +
          '<section class="block"><div class="block-head"><h2>コインの きろく</h2></div><div class="rank-list">' +
          rl("かせいだ コイン ぜんぶ", "🪙 " + s.totalCoinsEarned.toLocaleString()) +
          rl("つかった コイン ぜんぶ", "🪙 " + s.totalCoinsSpent.toLocaleString()) +
          '<div class="ach-row"><span class="amid">' + coinLine + '</span></div>' +
          '</div></section>' +
          '<section class="block"><div class="block-head"><h2>来た日の きろく</h2></div><div class="rank-list">' +
          rl("はじめて あそんだ日", s.firstDay ? s.firstDay.replace(/-/g, "/") : "まだ ない") +
          rl("あそんだ日 ぜんぶ", daysPlayed + " 日") +
          rl("きのう あそんだ？", s.days[yest] ? "あそんだ ✓" : "あそんでいない") +
          rl("きょう あそんだ？", s.days[today] ? "あそんだ ✓" : "まだ") +
          rl("この 7日で あそんだ日", last7 + " 日") +
          '</div></section>' +
          '<section class="block"><div class="block-head"><h2>いちばんの きろく</h2></div><div class="rank-list">' +
          rl("ベストスコア（60びょう）", save.best.toLocaleString() + " 点") +
          rl("エンドレス ベストスコア", en().bestScore.toLocaleString() + " 点") +
          rl("エンドレス ベストタイム", fmtElapsed(en().bestTime)) +
          rl("ランク戦 ベスト", rk().best.toLocaleString() + " 点") +
          rl("ニアミス ぜんぶ", save.totNear.toLocaleString() + " 回") +
          rl("星 ぜんぶ", save.totStars.toLocaleString() + " 個") +
          '</div></section>';
        var ach = $("records-ach");
        if (ach){
          ach.innerHTML = ACHIEVEMENTS.map(function(a){
            var cur = Math.min(a.cur(), a.target), done = a.cur() >= a.target;
            return '<div class="ach-row' + (done ? "" : " locked") + '"><span class="aic">' + (done ? a.ic : "🔒") + '</span><span class="amid">' + a.t + '<span class="ads">' + (done ? "たっせい！" : "あと " + (a.target - a.cur()).toLocaleString() + a.unit) + '</span></span><span class="ach-prog' + (done ? " done" : "") + '">' + cur.toLocaleString() + " / " + a.target.toLocaleString() + a.unit + '</span></div>';
          }).join("");
        }
        var alb = $("records-album");
        if (alb){
          var A = albumState();
          alb.innerHTML = ALBUM_CARDS.map(function(c){
            var owned = !!A[c.id];
            return '<div class="album-card' + (owned ? "" : " locked") + '"><div class="ac-ic">' + (owned ? c.ic : "❔") + '</div><div class="ac-t">' + (owned ? c.t : "まだの カード") + '</div><div class="ac-d">' + c.d + '</div>' + (owned ? '<div class="ac-line">「' + c.line + '」</div>' : "") + '</div>';
          }).join("");
        }
      }
      function renderEndlessCollection(){
        var el = $("collection-endless"); if (!el) return;
        var e = en(), bal = e.coins || 0;
        function card(key){
          var it = ENDLESS_ITEMS[key], owned = !!e.items[key];
          var right = "";
          if (owned){
            if (key === "comet") right = '<button class="mini-equip' + (save.skin === "endless_comet" ? " off" : "") + '" data-endless-equip="comet">' + (save.skin === "endless_comet" ? "つかっている" : "つかう") + '</button>';
            if (key === "sparkle") right = '<button class="mini-equip' + (trails().equip === "sparkle" ? " off" : "") + '" data-endless-equip="sparkle">' + (trails().equip === "sparkle" ? "つけている" : "つける") + '</button>';
            if (key === "outfit") right = '<button class="mini-equip' + (e.outfitOn ? " off" : "") + '" data-endless-equip="outfit">' + (e.outfitOn ? "つけている" : "つける") + '</button>';
          }
          var state = owned
            ? '<span class="mc-ds">もっている（ずっと つかえる）</span>'
            : '<span class="mc-ds">ねだん ⬡ <b>' + it.price + '</b> まい ／ いま <b>' + bal + '</b> まい — ' + (bal >= it.price ? '<b>買えるよ！</b> ショップへ 行こう' : 'あと <b>' + (it.price - bal) + ' まい</b> で 買える') + '</span>';
          return '<div class="mode-card" style="margin-top:10px"><span class="mc-tt">' + it.ic + ' ' + it.kind + '「' + it.name + '」' + (owned ? ' <span class="limited-badge" style="background:#12b76a;color:#fff">もっている</span>' : "") + '</span>' +
            '<span class="mc-ds">' + it.desc + '。エンドレスコインでだけ 買える（ふつうの コイン・お金・ガチャでは 買えない）。</span>' + state +
            (right ? '<div style="margin-top:10px">' + right + '</div>' : "") + '</div>';
        }
        el.innerHTML =
          '<div class="mode-card" style="margin-top:10px"><span class="mc-tt">⬡ エンドレスコイン <span class="num">' + bal + '</span> まい</span>' +
          '<span class="mc-ds">エンドレスで あつめた コインで 買えるよ。エンドレスでは カケラは 出ないよ（かわりに この コインが 出る）。</span>' +
          '<span class="mc-ds">エンドレスの ベスト： 時間 <b>' + fmtElapsed(e.bestTime) + '</b> ／ スコア <b>' + e.bestScore.toLocaleString() + '</b> 点</span>' +
          '<div style="margin-top:10px"><button class="mini-equip" id="btn-goto-endless-shop">🛒 ショップの「エンドレス限定」へ</button></div></div>' +
          card("comet") + card("sparkle") + card("outfit");
        var gb = $("btn-goto-endless-shop");
        if (gb) gb.addEventListener("click", function(){
          showView("shop"); renderAll();
          var sec = $("shop-endless-section");
          if (sec) setTimeout(function(){ try { sec.scrollIntoView({ behavior:"smooth", block:"start" }); } catch(err){} }, 60);
        });
        Array.prototype.forEach.call(el.querySelectorAll("[data-endless-equip]"), function(b){
          b.addEventListener("click", function(){
            var k = b.getAttribute("data-endless-equip");
            if (k === "comet"){ save.skin = save.skin === "endless_comet" ? "normal" : "endless_comet"; toast(save.skin === "endless_comet" ? "スキン「コメット」を つけた" : "スキンを ノーマルに もどした"); }
            if (k === "sparkle"){ trails().equip = trails().equip === "sparkle" ? "none" : "sparkle"; toast(trails().equip === "sparkle" ? "こんせき「星のきらめき」を つけた" : "こんせきを はずした"); }
            if (k === "outfit"){ en().outfitOn = !en().outfitOn; toast(en().outfitOn ? "衣装「エンドレス・カラー」を つけた（いまの キャラの 色ちがい）" : "エンドレス・カラーを はずした"); }
            persist(); renderAll();
          });
        });
      }
      /* ---- conditional gal lines: one short line per situation ---- */
      var GAL_LINES = {
        mia: {
          firstDay:["おはよう！ きょうも いっしょに 走ろう", "きょうの さいしょの ラン！ いい日に しよう"],
          newBest:["新記録！ やったね、すごい！", "ベスト更新！ その ちょうし！"],
          endlessMile:["エンドレス すごい！ まだまだ いける？", "長く たえたね！ エンドレスコインも たまったね"],
          seasonTier:["シーズンの ティアが あがった！", "ごほうびトラックが すすんだね"],
          album:["アルバムに 新しい カード！ おもいで ふえたね", "カード ゲット！ あつめるの たのしいね"],
          clear:["完走！ おつかれさま！", "1分間 にげきれた！"],
          crash:["ドンマイ！ もう1回 いこう", "つぎは もっと 遠くまで いけるよ"]
        },
        sora: {
          firstDay:["よう、来たね。きょうの 一走り、付き合うよ", "一日の はじめは 軽く 流そう"],
          newBest:["記録更新。…やるじゃん", "ベスト更新だ。悪くない走りだった"],
          endlessMile:["まだ 走れる？ 限界に 近い顔してる", "長持ちしたね。コインも ふえたね"],
          seasonTier:["ティア 上がったよ。ごほうび チェックして", "シーズン すすんでるね"],
          album:["新しい カード。おもいでが ふえたね", "アルバム、また 1枚 ふえた"],
          clear:["完走。おつかれ", "1分、逃げきったね"],
          crash:["つぎ、行こう。切り替え大事", "ドンマイ。あと少しだった"]
        },
        hina: {
          firstDay:["おはよう〜。きょうも のんびり 走ろっか", "一日の はじまりは 星あつめからだね"],
          newBest:["新記録だ〜！ すごいすごい！", "ベスト更新！ 星も よろこんでるよ"],
          endlessMile:["なが〜く 走れたね。星が ついてきてるよ", "エンドレス、いいペースだよ〜"],
          seasonTier:["ティアが あがったよ。ごほうび 見てみて", "シーズンの 花が ひらいたね"],
          album:["カードが ふえた！ アルバムが にぎやかに なったね", "おもいで 1枚 ゲットだよ"],
          clear:["完走〜！ おつかれさま", "1分間、がんばったね"],
          crash:["ドンマイ〜。つぎは 星が 助けてくれるよ", "もう1回、ゆっくり 行こう"]
        }
      };
      function galLine(kind){
        var c = naviChar();
        var pool = (GAL_LINES[c.id] && GAL_LINES[c.id][kind]) || GAL_LINES.mia[kind] || GAL_LINES.mia.crash;
        return pool[Math.floor(Math.random() * pool.length)];
      }
      function galResultLine(){
        if (!lastRun) return galLine("clear");
        if (lastRun.albumNew && lastRun.albumNew.length) return galLine("album");
        if (lastRun.tierUp) return galLine("seasonTier");
        if (lastRun.isRecord) return galLine("newBest");
        if (lastRun.mode === "endless" && (lastRun.eCoins || 0) > 0) return galLine("endlessMile");
        if (lastRun.firstToday) return galLine("firstDay");
        if (lastRun.crashed) return galLine("crash");
        return galLine("clear");
      }
      function copyText(txt){
        function done(){ toast("スコアを コピーした！ はりつけられるよ"); }
        function fallback(){
          try {
            var ta = document.createElement("textarea");
            ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
            document.body.appendChild(ta); ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta); done();
          } catch(e){ toast("コピーできなかった…"); }
        }
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, fallback);
        else fallback();
      }

      function renderEndlessShop(){
        var bal = en().coins || 0;
        var top = $("shop-ecoins-top"); if (top) top.textContent = "⬡ " + bal;
        var hd = $("shop-ecoins"); if (hd) hd.textContent = "⬡ " + bal;
        var el = $("endless-shop"); if (!el) return;
        var e = en();
        function ownedOf(k){ return !!e.items[k]; }
        function equippedOf(k){
          if (k === "comet") return save.skin === "endless_comet";
          if (k === "sparkle") return trails().equip === "sparkle";
          if (k === "outfit") return !!e.outfitOn;
          return false;
        }
        el.innerHTML = ["comet","sparkle","outfit"].map(function(k){
          var it = ENDLESS_ITEMS[k], owned = ownedOf(k), eq = equippedOf(k);
          var right = owned
            ? '<div class="p owned-tag">' + (eq ? "つかっている" : "買った") + '</div><div class="b">' + (eq ? "タップで はずす" : "タップで つかう") + '</div>'
            : '<div class="p" style="color:#0284c7">⬡ ' + it.price + '</div><div class="b">' + (bal >= it.price ? "エンドレスコインで 買う" : "あと " + (it.price - bal) + " まい") + '</div>';
          return '<button class="shop-card" data-endless-buy="' + k + '">' +
            '<span class="shop-ic ic-cyan">' + it.ic + '</span>' +
            '<span class="mid"><span class="tt">' + it.kind + '「' + it.name + '」</span><span class="ds">' + it.desc + '</span>' + (owned ? "" : endlessShortfallHtml(it.price)) + '</span>' +
            '<span class="pr">' + right + '</span></button>';
        }).join("");
        Array.prototype.forEach.call(el.querySelectorAll("[data-endless-buy]"), function(btn){
          btn.addEventListener("click", function(){
            var k = btn.getAttribute("data-endless-buy");
            var it = ENDLESS_ITEMS[k], ee = en(), bal2 = ee.coins || 0;
            if (ee.items[k]){
              if (k === "comet"){ save.skin = save.skin === "endless_comet" ? "normal" : "endless_comet"; toast(save.skin === "endless_comet" ? "スキン「コメット」を つけた" : "スキンを ノーマルに もどした"); }
              if (k === "sparkle"){ trails().equip = trails().equip === "sparkle" ? "none" : "sparkle"; toast(trails().equip === "sparkle" ? "こんせき「星のきらめき」を つけた" : "こんせきを はずした"); }
              if (k === "outfit"){ ee.outfitOn = !ee.outfitOn; toast(ee.outfitOn ? "衣装「エンドレス・カラー」を つけた（いまの キャラの 色ちがい）" : "エンドレス・カラーを はずした"); }
              persist(); renderAll(); return;
            }
            if (bal2 < it.price){ toast("エンドレスコインが あと " + (it.price - bal2) + " まい たりないよ。エンドレスで あつめよう（ふつうの コインや お金では 買えない）"); return; }
            ee.coins = bal2 - it.price; ee.items[k] = true;
            if (k === "comet"){ save.owned.endless_comet = true; save.skin = "endless_comet"; }
            if (k === "sparkle"){ trails().sparkle = true; trails().equip = "sparkle"; }
            if (k === "outfit"){ ee.outfitOn = true; }
            persist(); sfx.buy(); renderAll();
            toast(it.kind + "「" + it.name + "」を 買って つけた！（エンドレスコイン ⬡ " + it.price + " まい・見た目だけ）");
          });
        });
      }
      function renderAll(){ renderHome(); renderLives(); renderAttackHome(); renderStatus(); renderRankings(); renderShop(); renderEndlessShop(); renderMissions(); renderGacha(); renderSettings(); renderFriends(); renderRanked(); renderNavi(); renderLimited(); renderPreRun(); renderDaily(); renderRecords(); renderSeasonPage(); }

      function onUpgradeTap(id){
        var u = UPGRADES.find(function(x){ return x.id === id; });
        var lv = save.upg[id];
        if (lv >= u.prices.length){ toast("もう いちばん上まで いっている"); return; }
        var price = u.prices[lv];
        if (save.coins < price){ openPackSheet(price - save.coins, u.title + " Lv." + (lv + 1)); return; }
        save.coins -= price; trackSpend(price); save.upg[id]++; persist(); sfx.buy();
        toast(u.title + " を Lv." + save.upg[id] + " に した！ ずっと つよく なった");
        renderAll();
      }
      function onSkinTap(id){
        var it = SKIN_SHOP.find(function(x){ return x.id === id; });
        if (save.owned[id]){
          save.skin = save.skin === id ? "normal" : id; persist();
          toast(save.skin === id ? "スキン「" + SKINS[id].name + "」を つけた" : "スキンを ノーマルに もどした");
          renderAll(); return;
        }
        if (save.coins < it.price){ openPackSheet(it.price - save.coins, it.title); return; }
        save.coins -= it.price; trackSpend(it.price); save.owned[id] = true; save.skin = id; persist(); sfx.buy();
        toast("スキン「" + SKINS[id].name + "」を 買って つけた！");
        renderAll();
      }
      function onMiscTap(id){
        if (id === "lives"){ openLivesSheet(); return; }
        if (id === "pack"){ openPackSheet(0, ""); return; }
        if (id === "box"){
          if (save.coins < 500){ openPackSheet(500 - save.coins, "ミステリーボックス"); return; }
          openSheet({
            ic:"🎁", title:"ミステリーボックス",
            desc:"かくりつ： コイン120（45%）／コイン350（30%）／コイン800（15%）／もっていない スキン（10%、かぶったら コイン300に かわる）。セットを そろえる タイプでは ない。",
            price:"🪙 500", buyLabel:"500コインで 開ける",
            onBuy: function(){
              save.coins -= 500; trackSpend(500);
              var roll = Math.random(), msg;
              if (roll < 0.45){ save.coins += 120; msg = "コイン 120 が 出た"; }
              else if (roll < 0.75){ save.coins += 350; msg = "コイン 350 が 出た！"; }
              else if (roll < 0.90){ save.coins += 800; msg = "コイン 800 の 大当たり！"; }
              else {
                var unowned = SKIN_SHOP.filter(function(s2){ return !save.owned[s2.id]; });
                if (unowned.length){
                  var got = unowned[Math.floor(Math.random() * unowned.length)];
                  save.owned[got.id] = true; save.skin = got.id;
                  msg = "スキン「" + SKINS[got.id].name + "」が 出た！";
                } else { save.coins += 300; msg = "スキンは ぜんぶ もっている → コイン 300に かわった"; }
              }
              persist(); sfx.box(); renderAll();
              toast("ミステリーボックス： " + msg);
            }
          });
          return;
        }
        if (id === "pass"){
          if (save.pass){ toast("もう つかっている"); return; }
          openSheet({
            ic:"🎫", title:"パス「広告なし＋ごほうび2倍」",
            desc:"広告なしで さくさく。宝箱の コインが ずっと 2倍に なる。",
            price:"¥250 / 月", buyLabel:"買ったことに する",
            onBuy: function(){ save.pass = true; persist(); toast("パスが つかえるように なった（モック）。宝箱が 2倍に！"); renderAll(); }
          });
        }
      }

      /* ================= MOCK PURCHASE SHEET ================= */
      var sheetCb = null;
      /* a sheet opened mid-run freezes the game so the player never dies while reading prices */
      function pauseForSheet(){ if (G && views.game.classList.contains("active") && G.running && !G.over && !G.crashed) G.paused = true; }
      function resumeFromSheet(){ if (G && G.paused){ G.paused = false; G.lastTs = performance.now(); } }
      function openSheet(opt){
        $("sheet-ic").textContent = opt.ic;
        $("sheet-title").textContent = opt.title;
        $("sheet-desc").textContent = opt.desc;
        $("sheet-price").textContent = opt.price;
        $("sheet-buy").textContent = opt.buyLabel || "買ったことに する";
        sheetCb = opt.onBuy;
        $("sheet-back").classList.add("on");
        pauseForSheet();
        audio();
      }
      function openLivesSheet(){
        if (publicMode()){ toast("こうかい版モードでは ライフは むげんだよ"); return; }
        refreshLives();
        if (save.lives >= LIVES_MAX){ toast("ライフは まんたんだよ（5 / 5）"); return; }
        openSheet({
          ic:"❤️", title:"ライフ ぜんぶ もどす（モック）",
          desc:"ライフは さいだい5、1時間で 1つ もどる。いま " + save.lives + " / 5、つぎに もどるまで あと " + fmtCountdown(livesNextMs()) + "。待たずに ぜんぶ もどす モック（走っている時の ふっかつは コイン150→300で べつ）。",
          price:"¥160 → ❤️ ×5", buyLabel:"ライフを ぜんぶ もどしたことに する",
          onBuy: function(){ save.lives = LIVES_MAX; save.livesTs = Date.now(); persist(); renderAll(); toast("ライフ ぜんぶ もどった（モック）5 / 5"); }
        });
      }
      function openPackSheet(shortfall, forWhat){
        // こうかい版モード: ¥の購入へは 誘導しない。やさしい案内だけ出す。
        if (publicMode()){ toast("コインは あそぶと たまるよ"); return; }
        var pack = COIN_PACKS[COIN_PACKS.length - 1];
        for (var i = 0; i < COIN_PACKS.length; i++){ if (COIN_PACKS[i].coins >= shortfall){ pack = COIN_PACKS[i]; break; } }
        openSheet({
          ic:"🪙",
          title: shortfall > 0 ? "あと " + shortfall + " コインで買える！" : "コインパック",
          desc: (forWhat ? forWhat + " まで、あと少し。" : "ほしいものまで、あと少し。") + "この パックで ちょうど とどく。",
          price: pack.price + " → 🪙 " + pack.coins,
          buyLabel: pack.coins + " コインを 買ったことに する",
          onBuy: function(){
            save.coins += pack.coins; persist(); renderAll();
            toast(pack.coins + " コイン ゲット（モック）。もっている コイン " + save.coins);
          }
        });
      }
      function closeSheet(){ $("sheet-back").classList.remove("on"); sheetCb = null; resumeFromSheet(); }
      $("sheet-cancel").addEventListener("click", closeSheet);
      $("sheet-back").addEventListener("click", function(e){ if (e.target === this) closeSheet(); });
      $("sheet-buy").addEventListener("click", function(){
        var cb = sheetCb; closeSheet();
        toast("買った（モック）— 本物の お金は かからない");
        if (cb) setTimeout(cb, 250);
      });

      /* ================= GAME ================= */
      var RUN_TIME = 60;
      var canvas = $("game"), ctx = canvas.getContext("2d");
      var stage = $("stage-wrap");
      var W = 0, H = 0, DPR = 1;
      function resize(){
        var r = stage.getBoundingClientRect();
        DPR = Math.min(window.devicePixelRatio || 1, 2.5);
        W = r.width; H = r.height;
        canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      }
      window.addEventListener("resize", resize);

      var ITEM_DEF = {
        magnet: { ic:"🧲", color:"#22d3ee", label:"マグネット" },
        shield: { ic:"🛡️", color:"#2ee6a8", label:"シールド" },
        slow:   { ic:"⏳", color:"#b79cff", label:"スロー" },
        x2:     { ic:"✖️", color:"#ff5b8f", label:"スコア×2" },
        coin:   { ic:"🪙", color:"#ffd23f", label:"コインボーナス" },
        barrier:{ ic:"🔥", color:"#ff9f1c", label:"バリア" },
        starrain:{ ic:"🌟", color:"#ffe066", label:"スターの雨" }
      };

      var G = null;
      function newGameState(resume, mode){
        return {
          running:false, over:false,
          time: resume ? resume.time : RUN_TIME,
          total: RUN_TIME,
          score: resume ? resume.score : 0,
          elapsed: resume ? (RUN_TIME - resume.time) : 0,
          near: resume ? resume.near : 0,
          stars: resume ? resume.stars : 0,
          goldStars: resume ? resume.goldStars : 0,
          runCoins: 0, runXP: 0,
          combo: 0, maxCombo: resume ? resume.maxCombo : 0,
          comboTimer: 0,
          crashed: false, mode: mode || "casual",
          endlessMins: 0, endlessNewItems: [],
          clutchNear: 0, clutchMaxCombo: 0, clutchHit: false, frenzyHit: false, usedItems: [],
          attacksLeft: 1, attacksObtained: 1, attacksBought: 0, paused: false,
          grace: resume ? 2.2 : 0,
          phase: 1, warned10: false,
          magnetT: 0, slowT: 0, x2T: 0, invuln: 0, barrierT: 0,
          shieldCharges: mode === "ranked" ? 0 : startShieldCharges(),
          obstacles: [], starsArr: [], items: [], parts: [], floaters: [], lines: [], fragmentsArr: [], legendGot: 0, endlessCoinsArr: [], eCoinsRun: 0, spawnECoin: 12,
          spawnObs: resume ? 0.9 : 2.8, spawnStar: resume ? 1.1 : 0.6, spawnItem: 1.8, spawnGold: 7, spawnFragment: resume ? 14 : 8 + Math.random() * 4,
          bgScroll: 0, shake: 0, fxTimer: 0,
          gates: [], corridor: 0, corrSpawn: 0, corrTick: 0, corrCenter: 0, corrHalf: 62,
          nextSection: 11, sectionAlt: 0, sectionTimes: [11, 23, 35, 47], bgStars: [],
          starSpawned: 0, goldSpawned: 0, goldTimes: [8, 22, 36, 50], goldIdx: 0,
          event1: false, event2: false, ev1Type: "magnet", ev2Type: "shield", attacksUsed: 0,
          corrTarget: 0, corrMoveT: 0, rng: Math.random, diffId: "normal", diff: null, modifier: null, maxScore: 0, multAtStart: 1, skillId: null,
          player: { x: W/2, y: H*0.68, tx: W/2, ty: H*0.68, r: 15, trail: [], spin: 0 },
          lastTs: 0, raf: 0
        };
      }

      /* difficulty curve: 0-20s onboarding / 20-40s denser+moving / 40-60s frenzy.
         Final phase ramps asymptotically toward a cap instead of linearly, so speed never hits an unfair wall. */
      function speedAt(t){
        var base;
        if (t < 20) base = 240 + 5 * t;              // 240 -> 340
        else if (t < 40) base = 340 + 7 * (t - 20);       // 340 -> 480
        else base = 480 + 175 * (1 - Math.exp(-(t - 40) / 16));  // 480 -> ~605, easing toward ~655
        if (G && G.mode === "endless" && t > 60){
          // endless keeps rising slowly toward a higher cap, with a gentle
          // breathing rhythm (brief easier dips) so it never becomes a wall
          base += 150 * (1 - Math.exp(-(t - 60) / 150));
          base *= 1 - 0.07 * (0.5 + 0.5 * Math.sin((t - 60) / 11));
        }
        return base * (G && G.diff ? G.diff.speed : 1);   // difficulty lever 1: obstacle speed only
      }
      function spawnInterval(t){
        var base;
        if (t < 20) base = 0.95 - 0.010 * t;         // .95 -> .75
        else if (t < 40) base = 0.75 - 0.010 * (t - 20);  // .75 -> .55
        else base = 0.55 - 0.0085 * (t - 40);             // .55 -> .38
        // difficulty lever: density feel only, with a hard floor so spawns never become unsolvable
        return Math.max(0.34, base * (G && G.diff ? G.diff.spawnMul : 1));
      }
      function phaseAt(t){ return t < 20 ? 1 : t < 40 ? 2 : 3; }

      function startRun(resume, mode){
        showView("game");
        resize();
        cancelAnimationFrame(G ? G.raf : 0);
        var runMode = resume ? (lastRun ? lastRun.mode : "casual") : (mode === "ranked" ? "ranked" : mode === "endless" ? "endless" : "casual");
        G = newGameState(resume, runMode);
        // character skill: the title-selected character's skill, casual runs only (ranked = fixed conditions, no skill)
        G.skillId = runMode === "ranked" ? null : naviChar().id;
        if (resume){
          G.event1 = true; G.event2 = true;   // mid-run events do not refire on a continue segment
          G.diffId = (lastRun && lastRun.diffId && lastRun.diffId !== "ranked") ? lastRun.diffId : "normal";
          G.diff = DIFFS[G.diffId] || DIFFS.normal;
          G.modifier = lastRun ? lastRun.modifier : null;
          G.multAtStart = lastRun ? (lastRun.multAtStart || 1) : 1;
          G.maxScore = lastRun ? (lastRun.maxScore || SCORE_MAX_BASE) : SCORE_MAX_BASE;
          G.rng = mulberry32((Math.random() * 1e9) | 0);
        } else {
          // difficulty is casual + endless; the weekly modifier is casual-only
          // (ranked = fixed normal parameters, endless = pure, no modifier)
          G.diffId = runMode === "ranked" ? "normal" : diffOf();
          G.diff = DIFFS[G.diffId];
          G.modifier = runMode === "casual" ? currentModifier().id : null;
          G.rng = mulberry32(((Date.now() % 2147483647) ^ ((Math.random() * 1e9) | 0)) >>> 0);
          G.goldTimes = (G.modifier === "gold" ? [4, 12, 20, 28] : [8, 22, 36, 50]).map(function(t){ return t + G.rng() * 3; });
          G.sectionTimes = [11, 23, 35, 47].map(function(t){ return t + (G.rng() * 2 - 1); });
          if (runMode === "endless"){
            // endless: sections and gold stars keep coming on a slow schedule
            G.sectionTimes = [];
            for (var eti = 11; eti < 1800; eti += 12) G.sectionTimes.push(eti + (G.rng() * 2 - 1));
            G.goldTimes = [];
            var gt0 = 25;
            for (var gti = 0; gti < 24; gti++){ G.goldTimes.push(gt0 + G.rng() * 4); gt0 += 34 + gti * 4; }
          }
          var evPool = ["magnet", "shield", "slow", "x2", "coin", "barrier", "starrain"];
          G.ev1Type = evPool[(G.rng() * evPool.length) | 0];
          do { G.ev2Type = evPool[(G.rng() * evPool.length) | 0]; } while (G.ev2Type === G.ev1Type);
          if (G.modifier === "shield") G.shieldCharges = Math.min(5, G.shieldCharges + 1);
          if (G.skillId === "sora") G.shieldCharges = Math.min(5, G.shieldCharges + 1);   // Sora skill: start with one extra shield ("バリア1つ")
          G.multAtStart = runMode === "ranked" ? 1 : permMult();
          G.maxScore = Math.round(SCORE_MAX_BASE * G.multAtStart);
          if (runMode === "endless") G.maxScore = 0;   // endless has no MAX: it ends on crash
          if (runMode === "casual") setTimeout(function(){ toast("レベル： " + DIFFS[G.diffId].label + " ・ 今週のボーナス： " + currentModifier().name); }, 650);
          if (runMode === "endless") setTimeout(function(){ toast("🏃 エンドレス： ⬡ エンドレスコインを あつめよう！ カケラは 出ないよ"); }, 650);
        }
        G.corrTarget = W / 2;
        var hctx = $("hud-context");
        if (hctx) hctx.textContent = runMode === "ranked" ? "🏆 ランク戦（みんな同じ ルール）" : runMode === "endless" ? "🏃 エンドレス（ぶつかるまで） ・ レベル： " + DIFFS[G.diffId].label : "レベル： " + DIFFS[G.diffId].label + " ・ " + currentModifier().ic + " " + currentModifier().name;
        var hsk = $("hud-skill");
        if (hsk) hsk.textContent = G.skillId ? naviChar().skillIc + " スキル中：" + naviChar().skillLine.replace("スキル：", "") : "";
        if (resume){
          G.attacksLeft = resume.attacksLeft || 0;
          G.attacksObtained = resume.attacksObtained || 1;
          G.attacksBought = resume.attacksBought || 0;
        } else if (runMode === "ranked"){
          // fair standardized conditions: exactly 1 attack, no purchased extras, no gacha stock, baseline stats (via run* helpers)
          G.attacksBought = 0; G.attacksObtained = 1; G.attacksLeft = 1; G.usedItems = [];
          setTimeout(function(){ toast("🏆 ランク戦： みんな同じ ルール（追加で 買えない・ふっかつ なし）"); }, 500);
        } else {
          G.attacksBought = preAttacks;
          G.attacksObtained = 1 + preAttacks;
          G.attacksLeft = G.attacksObtained;
          preAttacks = 0;
          renderAttackHome();
          // gacha item stock: consumed at run start, announced so the player sees what fired
          if (!save.itemStock) save.itemStock = { attack:0, shield:0, magnet:0, x2:0 };
          var usedItems = [];
          while (save.itemStock.attack > 0 && G.attacksObtained < ATTACK_MAX){
            save.itemStock.attack--; G.attacksObtained++; G.attacksLeft++; G.attacksBought++; usedItems.push("攻撃チケット");
          }
          if (save.itemStock.shield > 0){ save.itemStock.shield--; G.shieldCharges = Math.min(5, G.shieldCharges + 1); usedItems.push("スタートシールド"); }
          if (save.itemStock.magnet > 0){ save.itemStock.magnet--; G.magnetT = 5; usedItems.push("スタートマグネット"); }
          if (save.itemStock.x2 > 0){ save.itemStock.x2--; G.x2T = 10; usedItems.push("スタート×2"); }
          G.usedItems = usedItems;
          if (usedItems.length){ persist(); setTimeout(function(){ toast("ガチャアイテムを つかった： " + usedItems.join("・")); }, 400); }
        }
        updateAttackBtn();
        G.corrCenter = W / 2;
        for (var bsi = 0; bsi < 80; bsi++){
          G.bgStars.push({ x: Math.random() * W, y: Math.random() * H, s: Math.random() < .6 ? 2 : 3, v: 14 + Math.random() * 46, c: Math.random() < .72 ? "#ffffff" : (Math.random() < .5 ? "#00e5ff" : "#ffffff") });
        }
        if (!resume){
          revivesUsed = 0;
          // first seconds are curated generosity: a line of stars before any real threat
          for (var si = 0; si < 5; si++){
            G.starsArr.push({ x: W/2 + (si - 2) * 34, y: 30 + si * 52, r: 13, gold: false, spin: Math.random() * 6, pulse: Math.random() * 6 });
          }
          G.starSpawned = 5;   // the curated opening line counts toward the fixed star total (40)
        }
        lastHudScore = -1; lastChips = ""; lastAtkStr = "";
        if (!resume && G.mode !== "endless" && !legendOwnedNow()) setTimeout(function(){ toast("◆ 伝説のカケラ " + lg().fragments + " / " + FRAGMENTS_NEED + " — 流れてきたら ひろおう（ガチャや お店では 手に入らない）"); }, 1600);
        updateHUD();
        $("drag-hint").classList.remove("hide");
        $("fx-chips").innerHTML = "";
        var overlay = $("count-overlay"), num = $("count-num");
        overlay.classList.add("on");
        var seq = ["3","2","1","GO!"];
        var i = 0;
        audio();
        function step(){
          if (!G || G.over) { overlay.classList.remove("on"); return; }
          if (i >= seq.length){
            overlay.classList.remove("on");
            G.running = true;
            bgmPlay(false);
            G.lastTs = performance.now();
            G.raf = requestAnimationFrame(loop);
            return;
          }
          num.textContent = seq[i];
          num.classList.remove("pop"); void num.offsetWidth; num.classList.add("pop");
          if (seq[i] === "GO!") sfx.go(); else sfx.count();
          i++;
          setTimeout(step, seq[i-1] === "GO!" ? 300 : 430);
        }
        step();
        drawFrame(0);
      }

      /* ----- input: 1-finger drag ----- */
      var pointerDown = false;
      function setTarget(e){
        var r = canvas.getBoundingClientRect();
        var cx = (e.clientX - r.left), cy = (e.clientY - r.top);
        if (G){
          G.player.tx = Math.max(18, Math.min(W - 18, cx));
          G.player.ty = Math.max(50, Math.min(H - 24, cy - 64));
          $("drag-hint").classList.add("hide");
        }
      }
      canvas.addEventListener("pointerdown", function(e){ pointerDown = true; try{ canvas.setPointerCapture(e.pointerId); }catch(err){} setTarget(e); audio(); });
      canvas.addEventListener("pointermove", function(e){ if (pointerDown) setTarget(e); });
      canvas.addEventListener("pointerup", function(){ pointerDown = false; });
      canvas.addEventListener("pointercancel", function(){ pointerDown = false; });
      canvas.addEventListener("touchmove", function(e){ e.preventDefault(); }, { passive:false });

      /* ----- spawning ----- */
      var AMOEBA_COLORS = ["#8b5cf6","#14b8a6","#7c3aed","#0d9488","#a855f7","#2dd4bf"];
      function makeRock(x, y, r, drift){
        return {
          x: x, y: y, r: r,
          vx: drift ? (rnd() < .5 ? -1 : 1) * (25 + rnd() * 45) * (G && G.diff ? G.diff.driftMul : 1) : 0,
          rot: Math.random() * Math.PI * 2, vr: (Math.random() - .5) * 2.4,
          wob: Math.random() * Math.PI * 2,
          minDist: 1e9, nearDone: false, verts: 7 + (Math.random()*3|0),
          kind: Math.random() < 0.5 ? 0 : 1,
          color: AMOEBA_COLORS[(Math.random() * AMOEBA_COLORS.length) | 0],
          frameSeed: Math.random() * 4, noNear: false
        };
      }
      function spawnObstacle(){
        var ph = G.phase, roll = rnd(), df = G.diff || DIFFS.normal;
        if (ph >= 3 && roll < 0.30){
          // wall with a gap: gap width is a difficulty lever, floored at 72px so it is always passable
          var gapW = Math.max(72, df.wallGap + rnd() * 10), gapX = 8 + rnd() * (W - gapW - 16);
          for (var x = 30; x < W; x += 58){
            if (x > gapX - 6 && x < gapX + gapW + 6) continue;
            G.obstacles.push(makeRock(x, -34, 25 + rnd() * 4, false));
          }
          return;
        }
        if (ph >= 2 && roll < 0.28){
          // pair: the clear gap between the two rocks is guaranteed >= 56px (player is ~36px wide)
          var r1 = 17 + rnd() * 15, r2 = 17 + rnd() * 15;
          var off = Math.max(r1 + r2 + 56, 100 + rnd() * 26);
          var cx = Math.max(off / 2 + 22, Math.min(W - off / 2 - 22, 70 + rnd() * (W - 140)));
          G.obstacles.push(makeRock(Math.max(20, cx - off/2), -30, r1, false));
          G.obstacles.push(makeRock(Math.min(W - 20, cx + off/2), -30 - rnd() * 30, r2, false));
          return;
        }
        var r = 16 + rnd() * (ph >= 3 ? 22 : ph === 2 ? 19 : 16);
        G.obstacles.push(makeRock(r + rnd() * (W - r*2), -r - 10, r, ph >= df.driftPhase));
      }
      /* ----- near-miss sections: GATE (one glowing gap in a wall) / CORRIDOR (thread the middle) ----- */
      function spawnGate(){
        var gapW = Math.max(78, Math.min(W - 40, 106 + rnd() * 16 + (G.diff ? G.diff.gateBonus : 0)));   // gap width lever, floored: always passable
        var gapX = 10 + rnd() * (W - gapW - 20);
        var gate = { gapX: gapX, gapW: gapW, y: -48, passed: false };
        G.gates.push(gate);
        for (var x = 6; x < W - 10; x += 39){
          var cx = x + 17;
          if (cx > gapX - 16 && cx < gapX + gapW + 16) continue;
          var o = makeRock(cx, gate.y, 17, false);
          o.noNear = true;                                   // the gate bonus itself scores the pass, no double count
          G.obstacles.push(o);
        }
        G.spawnObs = Math.max(G.spawnObs, 1.1);
        showBanner("⚠ GATE ⚠", "すきまを ぬけろ！ はし ギリギリで 大ボーナス");
        sfx.gate(); vibrate(20);
      }
      function startCorridor(){
        G.corridor = 5.5;
        G.corrCenter = W / 2;
        G.corrTarget = W / 2;
        G.corrHalf = G.diff ? G.diff.corrHalf : 62;
        G.corrSpawn = 0; G.corrTick = 0.3;
        showBanner("⛩ CORRIDOR ⛩", "りょうがわ かべ！ あいだを ぬけつづけて ニアミス");
        sfx.gate(); vibrate(20);
      }
      function spawnStar(gold, x, y, silent){
        if (gold) G.goldSpawned++; else G.starSpawned++;   // every spawned star counts toward the fixed per-run totals
        G.starsArr.push({
          x: x !== undefined ? x : 26 + Math.random() * (W - 52),
          y: y !== undefined ? y : -28,
          r: gold ? 24 : 13, gold: !!gold,
          spin: Math.random() * Math.PI * 2, pulse: Math.random() * Math.PI * 2
        });
        if (gold && !silent && G && G.running && !G.crashed){
          showBanner("⭐ BONUS STAR ⭐", "大きな 金星が 出た！ 白い ふちと BONUS が 目印");
          sfx.bonus(); vibrate(25);
        }
      }
      /* legend fragments: rare pickups that drift/flow down the field, swaying side to side.
         NOT in any gacha pool and NOT purchasable — runs are the only source. */
      function spawnLegendFragment(){
        if (!G || G.mode === "endless" || legendOwnedNow() || lg().fragments >= FRAGMENTS_NEED) return;
        G.fragmentsArr.push({ x: 34 + Math.random() * (W - 68), y: -30, r: 15, spin: Math.random() * Math.PI * 2, ph: Math.random() * Math.PI * 2 });
        showBanner("◆ 伝説のカケラ ◆", "むらさきピンクの けっしょう が 流れてきた！ ひろうと " + (lg().fragments + 1) + " / " + FRAGMENTS_NEED);
        sfx.mile(10); vibrate(20);
      }
      /* endless coins: silver-blue HEXAGON coins with an "E" mark and an
         「エンドレスコイン」 label — a shape/colour no other pickup uses
         (normal stars are pale-blue points, bonus stars are gold, normal
         coin items are gold circles, fragments are purple-pink crystals).
         Earned ONLY in endless runs; +1 per pickup. */
      function spawnEndlessCoin(){
        if (!G || G.mode !== "endless") return;
        G.endlessCoinsArr.push({ x: 36 + Math.random() * (W - 72), y: -34, r: 17, spin: Math.random() * Math.PI * 2, pulse: Math.random() * Math.PI * 2 });
        showBanner("⬡ エンドレスコイン ⬡", "六角形の 銀青コイン が 出た！ ひろうと +1 まい");
        sfx.bonus(); vibrate(20);
      }
      function spawnItem(){
        // weekly modifier only shifts which existing item is more likely; the item set itself never changes
        var w = { magnet:.20, shield:.15, slow:.13, x2:.13, coin:.16, barrier:.11, starrain:.12 };
        if (G && G.modifier === "magnet") w.magnet = .36;
        if (G && G.modifier === "shield") w.shield = .32;
        if (G && G.modifier === "starrain") w.starrain = .30;
        if (G && G.modifier === "x2") w.x2 = .30;
        var keys = Object.keys(w), tot = 0, i;
        for (i = 0; i < keys.length; i++) tot += w[keys[i]];
        var roll = rnd() * tot, acc = 0, type = "magnet";
        for (i = 0; i < keys.length; i++){ acc += w[keys[i]]; if (roll <= acc){ type = keys[i]; break; } }
        G.items.push({ x: 30 + rnd() * (W - 60), y: -30, r: 16, type: type, pulse: rnd() * 6 });
      }

      /* ----- effects ----- */
      function burst(x, y, color, n, spd){
        for (var i = 0; i < n; i++){
          var a = Math.random() * Math.PI * 2, s = (0.3 + Math.random() * 0.7) * (spd || 190);
          G.parts.push({ x:x, y:y, vx:Math.cos(a)*s, vy:Math.sin(a)*s, life:.5 + Math.random()*.35, max:.85, color:color, r: 1.6 + Math.random()*2.6 });
        }
      }
      function floater(x, y, text, color, size){
        G.floaters.push({ x:x, y:y, text:text, color:color, size:size || 19, life:.95, max:.95 });
      }
      var bannerTimer = null;
      function showBanner(title, sub, danger){
        $("phase-banner-t").textContent = title;
        $("phase-banner-s").textContent = sub || "";
        var b = $("phase-banner");
        b.classList.toggle("danger", !!danger);
        b.classList.add("on");
        clearTimeout(bannerTimer);
        bannerTimer = setTimeout(function(){ b.classList.remove("on"); }, 1700);
      }
      function showMilestone(title, sub, color){
        var m = $("milestone");
        $("milestone-t").textContent = title;
        $("milestone-t").style.color = color;
        $("milestone-s").textContent = sub || "";
        m.classList.remove("on"); void m.offsetWidth; m.classList.add("on");
      }
      function flash(kind){
        var f = $("lv-flash");
        f.className = "lv-flash" + (kind === "cyan" ? " cyan" : "");
        void f.offsetWidth;
        f.classList.add("on");
      }
      function celebrateLevel(){
        flash("");
        showMilestone("LEVEL UP!", "Lv." + save.level + " — スコアの倍率が あがった", "#ffd23f");
        sfx.levelup(); vibrate([30, 40, 30, 40, 60]);
        if (G) burst(G.player.x, G.player.y, "#ffd23f", 34, 300);
      }
      function gainXP(n){
        G.runXP += n;
        addXP(n);
        renderHome();
      }

      /* ----- main loop ----- */
      function loop(ts){
        if (!G || G.over) return;
        if (G.paused){ G.lastTs = ts; G.raf = requestAnimationFrame(loop); return; }
        var rawDt = Math.min((ts - G.lastTs) / 1000, 0.05);
        G.lastTs = ts;
        if (G.magnetT > 0) G.magnetT -= rawDt;
        if (G.slowT > 0) G.slowT -= rawDt;
        if (G.x2T > 0) G.x2T -= rawDt;
        if (G.barrierT > 0) G.barrierT -= rawDt;
        if (G.invuln > 0) G.invuln -= rawDt;
        var wdt = rawDt * (G.slowT > 0 ? 0.45 : 1);
        update(rawDt, wdt);
        drawFrame(wdt);
        updateHUD();
        while (pendingLevels > 0){ pendingLevels--; if (!G.crashed) celebrateLevel(); }
        if (!G.over) G.raf = requestAnimationFrame(loop);
      }

      function update(rawDt, wdt){
        if (G.crashed) return;
        var p = G.player;
        G.elapsed += rawDt;
        if (G.mode !== "endless") G.time -= rawDt;   // endless has no countdown: it ends on crash
        var final10 = G.mode !== "endless" && G.time <= 10 && G.time > 0;
        bgmSetFinal(final10);
        var mult = (final10 ? 2 : 1) * (G.x2T > 0 ? 2 : 1);
        var spd = speedAt(G.elapsed);
        G.bgScroll += spd * wdt * 0.9;
        for (var bs = 0; bs < G.bgStars.length; bs++){
          var bst = G.bgStars[bs];
          bst.y += (bst.v + spd * 0.22) * wdt;
          if (bst.y > H + 3){ bst.y = -3; bst.x = Math.random() * W; }
        }

        // phase transitions + last-10 warning
        var ph = phaseAt(G.elapsed);
        if (ph !== G.phase){
          G.phase = ph;
          if (ph === 2){ showBanner("PHASE 2", "岩が うごき出す・たくさん 出る"); sfx.item(); }
          if (ph === 3){ showBanner("PHASE 3 — FRENZY", "いちばん速い・いちばん たくさん！"); sfx.alarm(); }
        }
        if (!G.warned10 && final10){
          G.warned10 = true;
          showBanner("🔥 CLUTCH TIME 🔥", "さいご10秒・ポイント×2！", true);
          sfx.alarm(); vibrate([40, 40, 40]);
        }

        // mid-run events (~20s / ~40s, once each): existing item effects only, announced with a banner
        if (!G.event1 && G.elapsed >= 20){ G.event1 = true; showBanner("⚡ EVENT ⚡", ITEM_DEF[G.ev1Type].label + " が 出た！"); applyItem(G.ev1Type, p); }
        if (!G.event2 && G.elapsed >= 40){ G.event2 = true; showBanner("⚡ EVENT ⚡", ITEM_DEF[G.ev2Type].label + " が 出た！"); applyItem(G.ev2Type, p); }

        // near-miss sections: exactly 4 per run (gate / corridor alternating) at fixed times with a
        // small seeded jitter — the section total is identical on every difficulty
        if (G.sectionAlt < G.sectionTimes.length && G.elapsed >= G.sectionTimes[G.sectionAlt] && G.corridor <= 0 && G.gates.length === 0){
          if (G.sectionAlt % 2 === 0) spawnGate(); else startCorridor();
          G.sectionAlt++;
        }

        G.score += 12 * rawDt * mult * runMult();

        // endless: each full minute survived is a milestone — banner, a small
        // fixed +300pt bonus, and the BGM tempo rises a little (cap x1.15).
        // There is no last-10s x2 in endless (no last 10 seconds exist).
        if (G.mode === "endless"){
          var emins = Math.floor(G.elapsed / 60);
          if (emins > G.endlessMins){
            G.endlessMins = emins;
            G.score += ENDLESS_MIN_BONUS;
            G.eCoinsRun += 5;
            showMilestone("1分クリア！", emins + "分 たった！ ボーナス +" + ENDLESS_MIN_BONUS + "pt ／ ⬡ エンドレスコイン +5", "#ffd23f");
            sfx.mile(10); vibrate(25);
            if (bgm.on) bgm.tempoMul = Math.min(1.15, 1 + 0.05 * emins);
          }
          checkEndlessItems();
        }

        var follow = Math.min(1, rawDt * 16 * (1 + 0.12 * (isRankedRun() ? 0 : st().speed)) * (G.skillId === "mia" ? 1.05 : 1));
        p.x += (p.tx - p.x) * follow;
        p.y += (p.ty - p.y) * follow;
        p.spin += wdt * 1.6;
        p.trail.unshift({ x:p.x, y:p.y });
        if (p.trail.length > 16) p.trail.pop();

        // skin particle emission (comet / inferno)
        G.fxTimer -= rawDt;
        if (save.skin !== "normal" && G.fxTimer <= 0){
          G.fxTimer = 0.04;
          var col = save.skin === "comet" ? "#ff9f5a" : save.skin === "inferno" ? (Math.random() < .5 ? "#ff5a2a" : "#ffb300") : save.skin === "endless_comet" ? (Math.random() < .5 ? "#7ef0ff" : "#ffffff") : "#fb3b7f";
          G.parts.push({ x: p.x + (Math.random()-.5)*10, y: p.y + 12, vx:(Math.random()-.5)*40, vy: 120 + Math.random()*80, life:.35 + Math.random()*.25, max:.6, color: col, r: 1.5 + Math.random()*2.4 });
        }

        if (G.grace > 0) G.grace -= rawDt;
        if (G.combo > 0){
          G.comboTimer -= rawDt;
          if (G.comboTimer <= 0) G.combo = 0;
        }

        G.spawnObs -= wdt;
        if (G.corridor > 0){ G.spawnObs = Math.max(G.spawnObs, 0.3); }   // corridor owns the spawns while it runs
        else if (G.spawnObs <= 0){ spawnObstacle(); G.spawnObs = spawnInterval(G.elapsed) * (0.75 + Math.random() * 0.5) * (G.elapsed < 10 ? 1.7 : 1); }
        G.spawnStar -= wdt;
        if (G.spawnStar <= 0 && G.mode === "endless"){
          // endless: stars keep coming forever (no fixed per-run total)
          if (rnd() < 0.5){
            var eclx = 30 + rnd() * (W - 60), ecln = 3 + (rnd() * 3 | 0);
            for (var eci = 0; eci < ecln; eci++) spawnStar(false, eclx, -28 - eci * 48);
            G.spawnStar = 3.0 + rnd() * 2.0;
          } else {
            spawnStar(false);
            G.spawnStar = 1.1 + rnd() * 1.4;
          }
        }
        else if (G.spawnStar <= 0 && G.starSpawned < STAR_TOTAL){
          // fixed total per run (40): clusters and droughts vary by the run seed, and a pacing
          // catch-up guarantees the full total is offered before the run ends
          var remain = STAR_TOTAL - G.starSpawned;
          var expected = STAR_TOTAL * Math.min(G.elapsed / 52, 1);
          if (remain <= 6 || G.starSpawned < expected - 5 || rnd() < 0.5){
            var clx = 30 + rnd() * (W - 60);
            var cln = Math.min(remain, 3 + (rnd() * 3 | 0));
            for (var ci = 0; ci < cln; ci++) spawnStar(false, clx, -28 - ci * 48);
            G.spawnStar = 3.0 + rnd() * 2.0;
          } else {
            spawnStar(false);
            G.spawnStar = 1.1 + rnd() * 1.4;
          }
        }
        // gold stars: fixed total per run (4) on a schedule — gold weeks only move them earlier
        if (G.goldIdx < G.goldTimes.length && G.elapsed >= G.goldTimes[G.goldIdx]){
          if (G.mode === "endless" || G.goldSpawned < GOLD_TOTAL) spawnStar(true);
          G.goldIdx++;
        }
        G.spawnItem -= wdt;
        if (G.spawnItem <= 0){ spawnItem(); G.spawnItem = ((G.phase >= 3 ? 1.7 : 2.1) + Math.random() * 1.6) / runLuck(); }
        if (G.mode !== "endless"){
          G.spawnFragment -= wdt;
          if (G.spawnFragment <= 0){ spawnLegendFragment(); G.spawnFragment = 17 + Math.random() * 9; }
        }
        // endless coins: a distinct pickup about every 12 seconds, endless only
        if (G.mode === "endless"){
          G.spawnECoin -= wdt;
          if (G.spawnECoin <= 0){ spawnEndlessCoin(); G.spawnECoin = 12; }
        }

        var comboMult = 1 + Math.min(G.combo, 20) * 0.1;

        // gates descend with the world; score the pass when the wall crosses the player
        for (var gi = G.gates.length - 1; gi >= 0; gi--){
          var gt = G.gates[gi];
          gt.y += spd * wdt;
          if (!gt.passed && gt.y >= p.y){
            gt.passed = true;
            if (p.x > gt.gapX && p.x < gt.gapX + gt.gapW){
              var dEdge = Math.min(p.x - gt.gapX, gt.gapX + gt.gapW - p.x);
              if (dEdge <= 30){
                G.near++; G.combo++; G.comboTimer = comboTime();
                if (G.combo > G.maxCombo) G.maxCombo = G.combo; clutchNote();
                var gpts = Math.round(150 * comboMult * runMult()) * mult;
                G.score += gpts; G.runCoins += 3; gainXP(12);
                var ex = (p.x - gt.gapX < gt.gapW / 2) ? gt.gapX : gt.gapX + gt.gapW;
                floater(p.x, p.y - 56, "すれすれゲート！ +" + gpts, "#3dff5e", 25);
                burst(ex, p.y, "#3dff5e", 22, 280); burst(p.x, p.y, "#ffd23f", 12, 220);
                G.shake = Math.max(G.shake, 8); flash("cyan"); sfx.gate(); vibrate(30);
              } else {
                var cpts = Math.round(40 * runMult()) * mult;
                G.score += cpts;
                floater(p.x, p.y - 52, "GATE CLEAR +" + cpts, "#00e5ff", 20);
                sfx.star();
              }
            }
          }
          if (gt.y > H + 70) G.gates.splice(gi, 1);
        }

        // corridor: walls on both sides, threading the middle keeps paying out
        if (G.corridor > 0){
          G.corridor -= rawDt;
          // the corridor center drifts slowly toward a seeded target, clamped so the
          // passage always stays on screen and reachable (max 26px/s)
          G.corrMoveT -= rawDt;
          if (G.corrMoveT <= 0){
            G.corrMoveT = 1.1 + rnd() * 0.8;
            var lo = G.corrHalf + 26, hi = Math.max(lo, W - G.corrHalf - 26);
            G.corrTarget = lo + rnd() * (hi - lo);
          }
          var cdx2 = G.corrTarget - G.corrCenter, cmax = 26 * rawDt;
          G.corrCenter += Math.max(-cmax, Math.min(cmax, cdx2));
          G.corrSpawn -= wdt;
          if (G.corrSpawn <= 0){
            G.corrSpawn = 0.42;
            for (var ci2 = 0; ci2 < 2; ci2++){
              var cx2 = G.corrCenter + (ci2 === 0 ? -1 : 1) * (G.corrHalf + 30) + (Math.random() - .5) * 8;
              G.obstacles.push(makeRock(cx2, -30, 17, false));
            }
          }
          G.corrTick -= rawDt;
          if (G.corrTick <= 0){
            G.corrTick = 0.55;
            var offC = Math.abs(p.x - G.corrCenter);
            if (offC < G.corrHalf){
              var nearEdge = G.corrHalf - offC <= 30;
              var tpts = Math.round((nearEdge ? 60 : 25) * comboMult * runMult()) * mult;
              G.score += tpts;
              if (nearEdge){
                G.near++; G.combo++; G.comboTimer = comboTime();
                if (G.combo > G.maxCombo) G.maxCombo = G.combo; clutchNote();
                floater(p.x, p.y - 52, "ニアスレッド！ +" + tpts, "#ff4fd8", 21);
                burst(p.x, p.y, "#ff4fd8", 8, 200); sfx.near(G.combo);
              } else {
                floater(p.x, p.y - 52, "ぬけつづけ中 +" + tpts, "#00e5ff", 16);
              }
            }
          }
        }

        // obstacles
        for (var i = G.obstacles.length - 1; i >= 0; i--){
          var o = G.obstacles[i];
          o.y += spd * wdt;
          o.x += o.vx * wdt;
          if (o.x < o.r){ o.x = o.r; o.vx = Math.abs(o.vx); }
          if (o.x > W - o.r){ o.x = W - o.r; o.vx = -Math.abs(o.vx); }
          o.rot += o.vr * wdt;
          o.wob += wdt * 2;
          var dx = o.x - p.x, dy = o.y - p.y;
          var d = Math.sqrt(dx*dx + dy*dy);
          if (d < o.minDist) o.minDist = d;
          var hitDist = p.r + o.r * 0.85;   // ~15% hitbox forgiveness: perceived danger > actual danger
          if (d < hitDist && G.grace <= 0 && G.invuln <= 0 && G.barrierT > 0){
              burst(o.x, o.y, "#ff9f1c", 26, 300);
              burst(o.x, o.y, "#ffd23f", 12, 220);
              floater(p.x, p.y - 48, "🔥 バリアで こわした！", "#ff9f1c", 20);
              G.score += Math.round(30 * runMult()) * mult;
              G.shake = Math.max(G.shake, 6);
              sfx.shield(); vibrate(30);
              G.obstacles.splice(i, 1);
              continue;
          }
          if (d < hitDist && G.grace <= 0 && G.invuln <= 0){
            if (G.shieldCharges > 0){
              G.shieldCharges--;
              if (G.phase >= 3) G.frenzyHit = true;
              if (G.time <= 10 && G.time > 0) G.clutchHit = true;
              G.invuln = 1.2;
              burst(o.x, o.y, "#2ee6a8", 24, 280);
              burst(o.x, o.y, "#ffffff", 10, 200);
              floater(p.x, p.y - 48, "🛡️ シールドで まもった！", "#2ee6a8", 20);
              G.shake = Math.max(G.shake, 7);
              sfx.shield(); vibrate(35);
              G.obstacles.splice(i, 1);
              continue;
            }
            crash(); return;
          }
          if (!o.nearDone && !o.noNear && o.y > p.y + p.r + o.r * 0.6){
            o.nearDone = true;
            if (o.minDist < hitDist * 2 && o.minDist >= hitDist - 4){   // near-miss zone ≈ 2x the kill zone
              G.near++;
              G.combo++; G.comboTimer = comboTime();
              if (G.combo > G.maxCombo) G.maxCombo = G.combo; clutchNote();
              var pts = Math.round(40 * comboMult * runMult()) * mult;
              G.score += pts;
              G.runCoins += 1;
              gainXP(4);
              floater(p.x, p.y - 42, "ニアミス +" + pts, "#ff9f1c", G.combo >= 5 ? 24 : 19);
              if (G.combo >= 3) floater(p.x, p.y - 70, G.combo + " COMBO!", "#fb3b7f", 17);
              if (G.combo === 5 || G.combo === 10 || G.combo === 20){
                showMilestone(G.combo + " COMBO!", G.combo === 20 ? "すごい！ そのまま にげきれ" : "コンボ すごい！", "#ff9f1c");
                sfx.mile(G.combo); vibrate(25);
                burst(p.x, p.y, "#ff9f1c", 20, 260);
              }
              burst(p.x, p.y, "#ffb35c", 9, 220);
              G.shake = Math.max(G.shake, 4);
              sfx.near(G.combo); vibrate(12);
            }
          }
          if (o.y - o.r > H + 30) G.obstacles.splice(i, 1);
        }

        // stars (+ magnet pull)
        for (var j = G.starsArr.length - 1; j >= 0; j--){
          var s = G.starsArr[j];
          s.y += spd * wdt * 0.96;
          s.spin += wdt * 3; s.pulse += wdt * 5;
          var sx = s.x - p.x, sy = s.y - p.y;
          var sd = Math.sqrt(sx*sx + sy*sy);
          if (G.magnetT > 0 && sd < runMagnetRadius() && sd > 1){
            var pull = 480 * wdt;
            s.x -= sx / sd * pull; s.y -= sy / sd * pull;
            sx = s.x - p.x; sy = s.y - p.y; sd = Math.sqrt(sx*sx + sy*sy);
          }
          if (sd < p.r + s.r + 6){
            if (s.gold){
              G.goldStars++;
              var gpts = Math.round(500 * comboMult * runMult()) * mult;
              G.score += gpts;
              G.runCoins += 30;
              gainXP(60);
              floater(s.x, s.y - 24, "⭐ GOLD STAR +" + gpts, "#ffd23f", 27);
              flash("");
              burst(s.x, s.y, "#ffd23f", 30, 300);
              burst(s.x, s.y, "#fff3b0", 14, 220);
              G.shake = Math.max(G.shake, 5);
              sfx.gold(); vibrate([25, 30, 25]);
            } else {
              G.stars++;
              G.comboTimer = Math.max(G.comboTimer, 1.6);
              var spts = Math.round(50 * comboMult * runMult()) * mult;
              G.score += spts;
              G.runCoins += 2;
              gainXP(10);
              floater(s.x, s.y - 18, "+" + spts, "#ffd23f", 18);
              burst(s.x, s.y, "#ffd23f", 10, 200);
              sfx.star();
            }
            G.starsArr.splice(j, 1); continue;
          }
          if (s.y - s.r > H + 30) G.starsArr.splice(j, 1);
        }

        // items
        for (var q = G.items.length - 1; q >= 0; q--){
          var it2 = G.items[q];
          it2.y += spd * wdt * 0.9;
          it2.pulse += wdt * 6;
          var ix = it2.x - p.x, iy = it2.y - p.y;
          if (Math.sqrt(ix*ix + iy*iy) < p.r + it2.r + 8){
            applyItem(it2.type, p);
            G.items.splice(q, 1); continue;
          }
          if (it2.y - it2.r > H + 30) G.items.splice(q, 1);
        }

        // endless coins: fall with the world — collect by touching (+1)
        for (var ei = G.endlessCoinsArr.length - 1; ei >= 0; ei--){
          var ec = G.endlessCoinsArr[ei];
          ec.y += spd * wdt * 0.96;
          ec.spin += wdt * 2.4; ec.pulse += wdt * 5;
          var edx = ec.x - p.x, edy = ec.y - p.y;
          if (Math.sqrt(edx * edx + edy * edy) < p.r + ec.r + 8){
            G.eCoinsRun++;
            floater(ec.x, ec.y - 26, "⬡ エンドレスコイン +1（いま " + G.eCoinsRun + " まい）", "#7dd3fc", 21);
            burst(ec.x, ec.y, "#7dd3fc", 16, 240); burst(ec.x, ec.y, "#e0f2fe", 8, 180); burst(ec.x, ec.y, "#0284c7", 8, 200);
            sfx.star(); vibrate(20);
            G.endlessCoinsArr.splice(ei, 1); continue;
          }
          if (ec.y - ec.r > H + 34) G.endlessCoinsArr.splice(ei, 1);
        }

        // legend fragments: drift down slowly, swaying — collect by touching
        for (var fi = G.fragmentsArr.length - 1; fi >= 0; fi--){
          var fg = G.fragmentsArr[fi];
          fg.y += spd * wdt * 0.72;
          fg.ph += wdt * 2.2;
          fg.x += Math.cos(fg.ph) * 34 * wdt;
          fg.x = Math.max(20, Math.min(W - 20, fg.x));
          fg.spin += wdt * 1.4;
          var fdx = fg.x - p.x, fdy = fg.y - p.y;
          if (Math.sqrt(fdx * fdx + fdy * fdy) < p.r + fg.r + 8){
            var L2 = lg();
            L2.fragments = Math.min(FRAGMENTS_NEED, L2.fragments + 1);
            G.legendGot++;
            burst(fg.x, fg.y, "#e879f9", 22, 280); burst(fg.x, fg.y, "#8b5cf6", 14, 220); burst(fg.x, fg.y, "#ffffff", 8, 180);
            if (L2.fragments >= FRAGMENTS_NEED && !L2.owned[curLegend().item.id]){
              L2.owned[curLegend().item.id] = true;
              L2.justUnlocked = true;
              floater(fg.x, fg.y - 30, "👑 LEGEND GET！ " + curLegend().item.name, "#e879f9", 24);
              showMilestone("LEGEND GET!", curLegend().item.name + " を ゲット！", "#e879f9");
              flash("cyan"); sfx.levelup(); vibrate([40, 40, 40, 40, 80]);
            } else {
              floater(fg.x, fg.y - 26, "◆ 伝説のカケラ " + L2.fragments + " / " + FRAGMENTS_NEED, "#e879f9", 22);
              sfx.gold(); vibrate(25);
            }
            persist();
            G.fragmentsArr.splice(fi, 1); continue;
          }
          if (fg.y - fg.r > H + 34) G.fragmentsArr.splice(fi, 1);
        }

        // particles / floaters / speed lines
        for (var a = G.parts.length - 1; a >= 0; a--){
          var pt = G.parts[a];
          pt.x += pt.vx * wdt; pt.y += pt.vy * wdt; pt.vy += 260 * wdt; pt.life -= rawDt;
          if (pt.life <= 0) G.parts.splice(a, 1);
        }
        for (var b = G.floaters.length - 1; b >= 0; b--){
          var f = G.floaters[b]; f.y -= 56 * rawDt; f.life -= rawDt;
          if (f.life <= 0) G.floaters.splice(b, 1);
        }
        if (Math.random() < wdt * 14 && G.elapsed > 6){
          G.lines.push({ x: Math.random() * W, y: -30, len: 40 + Math.random() * 70, life:.4 });
        }
        for (var c = G.lines.length - 1; c >= 0; c--){
          var L = G.lines[c]; L.y += spd * 2.1 * wdt; L.life -= rawDt;
          if (L.life <= 0 || L.y > H + 40) G.lines.splice(c, 1);
        }
        if (G.shake > 0) G.shake = Math.max(0, G.shake - rawDt * 16);

        if (G.mode !== "endless" && G.time <= 0){ G.time = 0; endRun(false); }
      }

      function applyItem(type, p){
        sfx.item(); vibrate(15);
        if (type === "magnet"){
          G.magnetT = G.modifier === "magnet" ? 7 : 5;
          floater(p.x, p.y - 48, "🧲 マグネット " + (G.modifier === "magnet" ? 7 : 5) + "秒！", "#22d3ee", 21);
          burst(p.x, p.y, "#22d3ee", 14, 220);
        } else if (type === "shield"){
          G.shieldCharges = Math.min(3, G.shieldCharges + 1);
          floater(p.x, p.y - 48, "🛡️ シールド +1", "#2ee6a8", 21);
          burst(p.x, p.y, "#2ee6a8", 14, 220);
        } else if (type === "slow"){
          G.slowT = 3;
          floater(p.x, p.y - 48, "⏳ スロー 3秒！", "#b79cff", 21);
          burst(p.x, p.y, "#b79cff", 14, 200);
        } else if (type === "x2"){
          G.x2T = 10;
          floater(p.x, p.y - 48, "✖️ スコア×2 10秒！", "#ff5b8f", 21);
          burst(p.x, p.y, "#ff5b8f", 14, 220);
        } else if (type === "coin"){
          G.runCoins += 50;
          floater(p.x, p.y - 48, "🪙 コインボーナス +50！", "#ffd23f", 22);
          burst(p.x, p.y, "#ffd23f", 18, 240);
          gainXP(10);
        } else if (type === "barrier"){
          G.barrierT = 5;
          floater(p.x, p.y - 48, "🔥 バリア 5秒・ダメージなし！", "#ff9f1c", 22);
          burst(p.x, p.y, "#ff9f1c", 20, 260);
        } else if (type === "starrain"){
          // star rain draws from the same fixed per-run star totals, so the MAX never changes
          var srN = 0;
          for (var sr = 0; sr < 10; sr++){
            var srGold = rnd() < 0.15 && (G.mode === "endless" || G.goldSpawned < GOLD_TOTAL);
            if (!srGold && G.mode !== "endless" && G.starSpawned >= STAR_TOTAL) break;
            spawnStar(srGold, 24 + rnd() * (W - 48), -20 - srN * 38 - rnd() * 24, true); srN++;
          }
          floater(p.x, p.y - 48, "🌟 スターの雨！", "#ffe066", 22);
          burst(p.x, p.y, "#ffe066", 18, 240);
        }
      }

      /* ----- attack: screen-clear. 1 free per run; coin extras raise the run total to max x3 ----- */
      function updateAttackBtn(){
        var b = $("btn-attack"); if (!b) return;
        var left = G ? G.attacksLeft : 1;
        var obtained = G ? G.attacksObtained : 1;
        $("attack-count").textContent = "×" + left;
        b.classList.remove("canbuy", "maxed");
        if (G && (G.mode === "ranked" || G.mode === "endless") && left <= 0){
          b.classList.add("maxed");
          $("attack-label").textContent = "攻撃";
          $("attack-sub").textContent = G.mode === "ranked" ? "ランク戦：追加で 買えない" : "エンドレス：追加で 買えない";
          b.setAttribute("aria-label", (G.mode === "ranked" ? "ランク戦" : "エンドレス") + "では 攻撃を 追加で 買えません");
          return;
        }
        if (left > 0){
          $("attack-label").textContent = "攻撃";
          $("attack-sub").textContent = "タップで ぜんぶ こわす";
          b.setAttribute("aria-label", "攻撃を使う。のこり " + left + " 回");
        } else if (obtained < ATTACK_MAX){
          b.classList.add("canbuy");
          $("attack-label").textContent = "攻撃";
          $("attack-sub").textContent = "🪙" + attackCost(obtained - 1) + " で ふやす";
          b.setAttribute("aria-label", "攻撃は つかい切った。コイン " + attackCost(obtained - 1) + " で ふやす");
        } else {
          b.classList.add("maxed");
          $("attack-label").textContent = "攻撃";
          $("attack-sub").textContent = "ここまで ×3";
          b.setAttribute("aria-label", "攻撃は この回の ここまでに たっした");
        }
      }
      function useAttack(){
        audio();
        if (!G || G.over || G.crashed || !G.running || G.paused) return;
        if (G.attacksLeft <= 0){ if (G.mode === "ranked"){ toast("ランク戦は みんな同じ ルール： 攻撃は 追加で 買えない"); return; } if (G.mode === "endless"){ toast("エンドレスでは 攻撃は 追加で 買えないよ（記録は 自分の力だけ）"); return; } offerAttackBuy(); return; }
        G.attacksLeft--;
        G.attacksUsed++;
        var n = G.obstacles.length;
        G.obstacles.forEach(function(o){
          burst(o.x, o.y, o.color || "#ffd23f", 10, 270);
          burst(o.x, o.y, "#ffffff", 4, 190);
        });
        G.obstacles.length = 0;
        G.gates.length = 0;
        var pts = n * 20;
        G.score += pts;
        floater(G.player.x, G.player.y - 64, "💥 ぜんぶ こわした！ +" + pts, "#ffd23f", 26);
        flash("cyan");
        G.shake = Math.max(G.shake, 11);
        sfx.boom(); vibrate([40, 30, 60]);
        updateAttackBtn();
      }
      function offerAttackBuy(){
        if (!G) return;
        if (G.attacksObtained >= ATTACK_MAX){ toast("攻撃は この回の ここまで（ぜんぶで ×3）だよ"); return; }
        var cost = attackCost(G.attacksObtained - 1);
        if (save.coins < cost){ openPackSheet(cost - save.coins, "攻撃"); return; }
        openSheet({
          ic:"💥", title:"攻撃を ふやす（モック）",
          desc:"いま： つかえる 攻撃 ×" + G.attacksLeft + "（この回の ぜんぶで " + G.attacksObtained + " / " + ATTACK_MAX + "）。買うと ぜんぶで " + (G.attacksObtained + 1) + " / " + ATTACK_MAX + "、つかえる 攻撃は ×" + (G.attacksLeft + 1) + " に なる。コインで 買う モックで、本物の お金は かからない。買っている あいだ ゲームは 止まる。",
          price:"🪙 " + cost, buyLabel:"コインで 攻撃を +1",
          onBuy: function(){
            save.coins -= cost; trackSpend(cost); G.attacksObtained++; G.attacksLeft++; persist(); renderHome(); updateAttackBtn();
            toast("攻撃 +1！ いま ×" + G.attacksLeft + "（ぜんぶで " + G.attacksObtained + " / " + ATTACK_MAX + "）");
          }
        });
      }

      function crash(){
        var p = G.player;
        if (G.phase >= 3) G.frenzyHit = true;
        if (G.time <= 10 && G.time > 0) G.clutchHit = true;
        burst(p.x, p.y, "#ff4757", 30, 300);
        burst(p.x, p.y, "#ffd23f", 16, 240);
        sfx.crash(); vibrate([60, 40, 90]);
        G.crashed = true;
        G.shake = 12;
        drawFrame(0);
        setTimeout(function(){ endRun(true); }, 620);
        G.running = false;
        var keep = G;
        (function anim(){
          if (G !== keep || keep.over) return;
          drawFrame(0.016);
          requestAnimationFrame(anim);
        })();
      }

      /* ----- drawing: amoeba blobs (procedural, squash & stretch) + pixel stars ----- */
      var SPR_STAR = [
        "...S...",
        "...S...",
        ".SSSSS.",
        "SSSSSSS",
        ".SSSSS.",
        "..S.S..",
        ".S...S."
      ];
      var SPR_STAR_BIG = [
        "....S....",
        "....S....",
        ".SSSSSSS.",
        "SSSSWSSSS",
        ".SSSSSSS.",
        "..SS.SS..",
        "..S...S..",
        ".S.....S."
      ];
      /* amoeba blob: a soft body that squashes, stretches and wobbles — drawn fresh every frame, no fixed sprite */
      function amoebaPath(cx, cy, r, t, wobble, seed){
        ctx.beginPath();
        var steps = 14;
        for (var i = 0; i <= steps; i++){
          var a = (i / steps) * Math.PI * 2;
          var rr = r * (1 + wobble * Math.sin(t * 3.1 + seed + a * 3) + wobble * 0.6 * Math.sin(t * 5.3 + seed * 2 - a * 2));
          var px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
          if (i === 0) ctx.moveTo(px, py);
          else {
            var pa = ((i - 0.5) / steps) * Math.PI * 2;
            var pr = r * (1 + wobble * Math.sin(t * 3.1 + seed + pa * 3) + wobble * 0.6 * Math.sin(t * 5.3 + seed * 2 - pa * 2)) * 1.05;
            ctx.quadraticCurveTo(cx + Math.cos(pa) * pr, cy + Math.sin(pa) * pr, px, py);
          }
        }
        ctx.closePath();
      }
      function drawAmoeba(cx, cy, r, color, t, seed, wobble){
        var sq = 1 + 0.13 * Math.sin(t * 4 + seed);   // squash & stretch, area roughly preserved
        ctx.save();
        ctx.translate(cx, cy); ctx.scale(1 / Math.sqrt(sq), sq); ctx.translate(-cx, -cy);
        amoebaPath(cx, cy, r, t, wobble, seed);
        ctx.fillStyle = color; ctx.fill();
        ctx.lineWidth = 3.5; ctx.strokeStyle = "#05060f"; ctx.stroke();
        ctx.beginPath(); ctx.arc(cx + r * 0.18, cy + r * 0.1, r * 0.34, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,.35)"; ctx.fill();
        ctx.beginPath(); ctx.arc(cx + r * 0.18, cy + r * 0.1, r * 0.2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(5,6,15,.28)"; ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,.4)";
        ctx.beginPath(); ctx.arc(cx - r * 0.42, cy - r * 0.3, r * 0.1, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + r * 0.5, cy - r * 0.42, r * 0.07, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      function drawSprite(cx, cy, rows, map, unit){
        var h = rows.length, w = rows[0].length;
        var x0 = cx - (w * unit) / 2, y0 = cy - (h * unit) / 2;
        for (var r = 0; r < h; r++){
          var row = rows[r];
          for (var c = 0; c < w; c++){
            var ch = row.charAt(c);
            if (ch === "." || !map[ch]) continue;
            ctx.fillStyle = map[ch];
            ctx.fillRect(x0 + c * unit, y0 + r * unit, unit + 0.6, unit + 0.6);
          }
        }
      }
      function drawStarShape(x, y, r, rot){
        ctx.beginPath();
        for (var i = 0; i < 10; i++){
          var rad = i % 2 === 0 ? r : r * 0.45;
          var a = rot + i * Math.PI / 5 - Math.PI / 2;
          var px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
      }
      function drawGhost(x, y, r, color, alpha, face){
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x - r, y + r * 0.85);
        ctx.lineTo(x - r, y - r * 0.05);
        ctx.arc(x, y - r * 0.05, r, Math.PI, 0);
        ctx.lineTo(x + r, y + r * 0.85);
        var steps = 4, wSeg = (r * 2) / steps;
        for (var i = 0; i < steps; i++){
          var x0 = x + r - i * wSeg;
          ctx.quadraticCurveTo(x0 - wSeg * 0.25, y + r * 0.45, x0 - wSeg * 0.5, y + r * 0.85);
          ctx.quadraticCurveTo(x0 - wSeg * 0.75, y + r * 1.2, x0 - wSeg, y + r * 0.85);
        }
        ctx.closePath(); ctx.fill();
        if (face){
          ctx.globalAlpha = Math.min(1, alpha + 0.3);
          ctx.fillStyle = "#141021";
          ctx.beginPath(); ctx.arc(x - r * 0.36, y - r * 0.05, r * 0.14, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(x + r * 0.36, y - r * 0.05, r * 0.14, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(x, y + r * 0.3, r * 0.16, 0, Math.PI); ctx.fill();
        }
        ctx.restore();
      }
      function drawFlame(x, y, r, flick){
        ctx.save();
        ctx.translate(x, y); ctx.scale(1, flick);
        var fg = ctx.createLinearGradient(0, -r * 1.3, 0, r);
        fg.addColorStop(0, "#ffd23f"); fg.addColorStop(0.45, "#ff7a18"); fg.addColorStop(1, "#ff3b30");
        ctx.beginPath();
        ctx.moveTo(0, -r * 1.3);
        ctx.bezierCurveTo(r * 0.95, -r * 0.25, r * 0.7, r * 0.55, 0, r * 0.95);
        ctx.bezierCurveTo(-r * 0.7, r * 0.55, -r * 0.95, -r * 0.25, 0, -r * 1.3);
        ctx.fillStyle = fg; ctx.fill();
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.55);
        ctx.bezierCurveTo(r * 0.45, -r * 0.05, r * 0.35, r * 0.35, 0, r * 0.6);
        ctx.bezierCurveTo(-r * 0.35, r * 0.35, -r * 0.45, -r * 0.05, 0, -r * 0.55);
        ctx.fillStyle = "rgba(255,240,180,.9)"; ctx.fill();
        ctx.restore();
      }
      function drawPlayerBody(skinId, p){
        // PLAYER = metallic silver ball: a perfect rigid circle. No squash, no stretch, no yellow.
        // Skins only change the thin accent ring around the ball; the ball itself is always silver.
        // Exceptions by shape: 「コメット」 grows a comet tail, 「ストライプボール」 wears stripes.
        var accents = { normal:"#22d3ee", phantom:"#fb3b7f", comet:"#ff8c4a", inferno:"#ff5a2a", mint:"#3ddc84", grape:"#b388ff", sakura:"#ff9ecb", lim_snow:"#dbeafe", lim_pumpkin:"#ff9f1c", lim_yozakura:"#c084fc", stripe:"#7fb2ff", endless_comet:"#35e0ff" };
        var accent = accents[skinId] || accents.normal;
        var R = p.r + 3;
        if (skinId === "endless_comet"){
          // comet tail: layered glowing wedges streaming below the ball, flickering
          var flick = 1 + 0.16 * Math.sin(performance.now() / 47);
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          var tailLen = 58 * flick;
          var tg = ctx.createLinearGradient(p.x, p.y, p.x, p.y + tailLen + R);
          tg.addColorStop(0, "rgba(160,245,255,.85)"); tg.addColorStop(0.45, "rgba(53,224,255,.4)"); tg.addColorStop(1, "rgba(53,224,255,0)");
          ctx.fillStyle = tg;
          ctx.beginPath();
          ctx.moveTo(p.x - R * 0.72, p.y + R * 0.35);
          ctx.quadraticCurveTo(p.x, p.y + tailLen + R * 1.15, p.x + R * 0.72, p.y + R * 0.35);
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,.5)";
          ctx.beginPath();
          ctx.moveTo(p.x - R * 0.34, p.y + R * 0.4);
          ctx.quadraticCurveTo(p.x, p.y + tailLen * 0.62, p.x + R * 0.34, p.y + R * 0.4);
          ctx.closePath(); ctx.fill();
          ctx.restore();
        }
        ctx.save();
        ctx.beginPath(); ctx.arc(p.x, p.y, R + 5, 0, Math.PI * 2);
        ctx.strokeStyle = accent; ctx.lineWidth = 2.5; ctx.globalAlpha = .8; ctx.stroke();
        ctx.globalAlpha = 1;
        var grad = ctx.createRadialGradient(p.x - R * .38, p.y - R * .42, R * .12, p.x, p.y, R * 1.05);
        grad.addColorStop(0, "#ffffff"); grad.addColorStop(.35, "#e6ecf4"); grad.addColorStop(.68, "#a9b6c8"); grad.addColorStop(.88, "#75839a"); grad.addColorStop(1, "#c3cedd");
        ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
        ctx.fillStyle = grad; ctx.fill();
        if (skinId === "stripe"){
          ctx.save();
          ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.clip();
          ctx.strokeStyle = "rgba(70,130,255,.6)"; ctx.lineWidth = 4.5;
          for (var sdi = -3; sdi <= 3; sdi++){
            ctx.beginPath();
            ctx.moveTo(p.x + sdi * 9 - R * 0.7, p.y + R + 3);
            ctx.lineTo(p.x + sdi * 9 + R * 0.7, p.y - R - 3);
            ctx.stroke();
          }
          ctx.restore();
        }
        ctx.lineWidth = 3; ctx.strokeStyle = "#05060f"; ctx.stroke();
        ctx.beginPath(); ctx.arc(p.x - R * .38, p.y - R * .42, R * .2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,.95)"; ctx.fill();
        ctx.beginPath(); ctx.arc(p.x - R * .3, p.y - R * .34, R * .08, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff"; ctx.fill();
        // small eyes: the only face on the field (enemy blobs have none)
        var eo = R * .32, ey = p.y + R * .08;
        ctx.fillStyle = "#0b1020";
        ctx.beginPath(); ctx.arc(p.x - eo, ey, 2.4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(p.x + eo, ey, 2.4, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      function drawFrame(dt){
        if (!G) return;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = "#05060f"; ctx.fillRect(0, 0, W, H);
        // scrolling pixel starfield (parallax: bigger stars sit brighter)
        G.bgStars.forEach(function(bs){
          ctx.globalAlpha = bs.s === 3 ? .95 : .5;
          ctx.fillStyle = bs.c;
          ctx.fillRect(bs.x, bs.y, bs.s, bs.s);
        });
        ctx.globalAlpha = 1;
        ctx.save();
        if (G.shake > 0) ctx.translate((Math.random() - .5) * G.shake, (Math.random() - .5) * G.shake);
        ctx.strokeStyle = "rgba(160,210,255,.3)"; ctx.lineWidth = 2;
        G.lines.forEach(function(L){
          ctx.beginPath(); ctx.moveTo(L.x, L.y); ctx.lineTo(L.x, L.y + L.len); ctx.stroke();
        });
        // corridor guide rails (dashed, scrolling)
        if (G.corridor > 0){
          ctx.save();
          ctx.strokeStyle = "rgba(61,255,94,.55)"; ctx.lineWidth = 3;
          ctx.setLineDash([12, 16]); ctx.lineDashOffset = -G.bgScroll * 1.4;
          [G.corrCenter - G.corrHalf, G.corrCenter + G.corrHalf].forEach(function(gx){
            ctx.beginPath(); ctx.moveTo(gx, -10); ctx.lineTo(gx, H + 10); ctx.stroke();
          });
          ctx.restore();
        }
        // gate gap: glowing edge posts + a gold arrow over the opening
        G.gates.forEach(function(gt){
          var blink = 0.65 + 0.35 * Math.sin(performance.now() / 70);
          ctx.save();
          ctx.shadowColor = "#3dff5e"; ctx.shadowBlur = 16;
          ctx.fillStyle = "rgba(61,255,94," + blink + ")";
          ctx.fillRect(gt.gapX - 5, gt.y - 30, 7, 60);
          ctx.fillRect(gt.gapX + gt.gapW - 2, gt.y - 30, 7, 60);
          ctx.fillStyle = "#3dff5e"; ctx.shadowColor = "#3dff5e";
          var ax = gt.gapX + gt.gapW / 2;
          ctx.beginPath(); ctx.moveTo(ax - 9, gt.y - 54); ctx.lineTo(ax + 9, gt.y - 54); ctx.lineTo(ax, gt.y - 39); ctx.closePath(); ctx.fill();
          ctx.restore();
        });
        var p = G.player;
        // phase 3 backdrop + final-10 danger vignette
        if (G.phase >= 3 && !G.over){
          ctx.fillStyle = "rgba(255,120,40," + (0.04 + 0.02 * Math.sin(performance.now() / 160)) + ")";
          ctx.fillRect(0, 0, W, H);
        }
        if (G.time <= 10 && G.time > 0 && G.running){
          ctx.fillStyle = "rgba(255,60,80," + (0.06 + 0.05 * Math.sin(performance.now() / 90)) + ")";
          ctx.fillRect(0, 0, W, H);
        }
        if (G.slowT > 0){
          ctx.fillStyle = "rgba(120,90,255,.07)"; ctx.fillRect(0, 0, W, H);
        }
        // magnet radius
        if (G.magnetT > 0 && !G.crashed){
          ctx.beginPath(); ctx.arc(p.x, p.y, runMagnetRadius(), 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(34,211,238," + (0.25 + 0.15 * Math.sin(performance.now() / 120)) + ")";
          ctx.lineWidth = 2; ctx.stroke();
        }
        // stars told apart by shape, not color alone:
        // normal = small pale-blue pointed star, dark outline, slow spin, no halo.
        // bonus = the ONLY gold object: big pointed star, thick white outline, gold halo, orbiting sparkles, BONUS label.
        G.starsArr.forEach(function(s){
          var pulseU = 1 + 0.1 * Math.sin(s.pulse);
          ctx.save();
          if (s.gold){
            var tB = performance.now() / 1000;
            var halo = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, s.r * 2.3);
            halo.addColorStop(0, "rgba(255,210,63,.55)"); halo.addColorStop(1, "rgba(255,210,63,0)");
            ctx.fillStyle = halo;
            ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 2.3, 0, Math.PI * 2); ctx.fill();
            for (var spk = 0; spk < 4; spk++){
              var sa = tB * 2.4 + spk * Math.PI / 2 + s.spin;
              var sx2 = s.x + Math.cos(sa) * s.r * 1.55, sy2 = s.y + Math.sin(sa) * s.r * 1.55;
              ctx.save(); ctx.translate(sx2, sy2); ctx.rotate(sa);
              ctx.fillStyle = "#ffffff";
              ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(2, -2); ctx.lineTo(6, 0); ctx.lineTo(2, 2); ctx.lineTo(0, 6); ctx.lineTo(-2, 2); ctx.lineTo(-6, 0); ctx.lineTo(-2, -2); ctx.closePath(); ctx.fill();
              ctx.restore();
            }
            drawStarShape(s.x, s.y, s.r * pulseU, s.spin);
            ctx.fillStyle = "#ffd23f"; ctx.fill();
            ctx.lineWidth = 5; ctx.strokeStyle = "#ffffff"; ctx.lineJoin = "round"; ctx.stroke();
            ctx.lineWidth = 1.6; ctx.strokeStyle = "rgba(5,6,15,.65)"; ctx.stroke();
            drawStarShape(s.x, s.y, s.r * 0.45 * pulseU, s.spin);
            ctx.fillStyle = "#fff3b0"; ctx.fill();
            ctx.font = "900 11px 'DotGothic16',sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
            var lw2 = 52, lx2 = s.x - lw2 / 2, ly2 = s.y - s.r - 24;
            ctx.fillStyle = "rgba(5,6,15,.88)"; ctx.fillRect(lx2, ly2, lw2, 16);
            ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.6; ctx.strokeRect(lx2, ly2, lw2, 16);
            ctx.fillStyle = "#ffd23f"; ctx.fillText("BONUS", s.x, ly2 + 8.5);
          } else {
            drawStarShape(s.x, s.y, s.r * pulseU, s.spin);
            ctx.fillStyle = "#aee9ff"; ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = "#05060f"; ctx.lineJoin = "round"; ctx.stroke();
            ctx.beginPath(); ctx.arc(s.x, s.y, 2.2, 0, Math.PI * 2); ctx.fillStyle = "#ffffff"; ctx.fill();
          }
          ctx.restore();
        });
        ctx.textBaseline = "alphabetic";
        // endless coins: silver-blue hexagon, white outline, "E" mark +
        // 「エンドレスコイン」 label — not a star, not a gold circle, not a crystal.
        G.endlessCoinsArr.forEach(function(ec){
          ctx.save();
          var ehalo = ctx.createRadialGradient(ec.x, ec.y, 2, ec.x, ec.y, ec.r * 2.1);
          ehalo.addColorStop(0, "rgba(125,211,252,.55)"); ehalo.addColorStop(1, "rgba(125,211,252,0)");
          ctx.fillStyle = ehalo;
          ctx.beginPath(); ctx.arc(ec.x, ec.y, ec.r * 2.1, 0, Math.PI * 2); ctx.fill();
          var epulse = 1 + 0.08 * Math.sin(ec.pulse);
          var er = ec.r * epulse;
          ctx.beginPath();
          for (var hi2 = 0; hi2 < 6; hi2++){
            var ha = Math.PI / 6 + hi2 * Math.PI / 3;
            var hx = ec.x + Math.cos(ha) * er, hy = ec.y + Math.sin(ha) * er;
            if (hi2 === 0) ctx.moveTo(hx, hy); else ctx.lineTo(hx, hy);
          }
          ctx.closePath();
          var eg = ctx.createLinearGradient(ec.x, ec.y - er, ec.x, ec.y + er);
          eg.addColorStop(0, "#e0f2fe"); eg.addColorStop(.5, "#7dd3fc"); eg.addColorStop(1, "#38bdf8");
          ctx.fillStyle = eg; ctx.fill();
          ctx.lineWidth = 4; ctx.strokeStyle = "#ffffff"; ctx.lineJoin = "round"; ctx.stroke();
          ctx.lineWidth = 1.4; ctx.strokeStyle = "rgba(5,6,15,.55)"; ctx.stroke();
          ctx.font = "900 " + Math.round(er * 1.05) + "px 'DotGothic16',sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillStyle = "#075985"; ctx.fillText("E", ec.x, ec.y + 1);
          ctx.restore();
          ctx.save();
          ctx.font = "900 10px 'DotGothic16',sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          var elw = 96, elx = Math.max(2, Math.min(W - elw - 2, ec.x - elw / 2)), ely = ec.y - ec.r - 27;
          ctx.fillStyle = "rgba(7,47,80,.92)"; ctx.fillRect(elx, ely, elw, 16);
          ctx.strokeStyle = "#7dd3fc"; ctx.lineWidth = 1.6; ctx.strokeRect(elx, ely, elw, 16);
          ctx.fillStyle = "#e0f2fe"; ctx.fillText("エンドレスコイン", ec.x, ely + 8.5);
          ctx.restore();
        });
        ctx.textBaseline = "alphabetic";
        // legend fragments: an elongated violet-pink crystal shard — a shape no other
        // object uses (not a star, not a circle, not a blob) — white outline + 「カケラ」 label.
        G.fragmentsArr.forEach(function(fg){
          ctx.save();
          var halo2 = ctx.createRadialGradient(fg.x, fg.y, 2, fg.x, fg.y, fg.r * 2.2);
          halo2.addColorStop(0, "rgba(196,77,255,.5)"); halo2.addColorStop(1, "rgba(196,77,255,0)");
          ctx.fillStyle = halo2;
          ctx.beginPath(); ctx.arc(fg.x, fg.y, fg.r * 2.2, 0, Math.PI * 2); ctx.fill();
          ctx.translate(fg.x, fg.y); ctx.rotate(Math.sin(fg.spin) * 0.35);
          ctx.beginPath();
          ctx.moveTo(0, -fg.r * 1.3); ctx.lineTo(fg.r * 0.72, -fg.r * 0.3); ctx.lineTo(fg.r * 0.55, fg.r * 0.85);
          ctx.lineTo(0, fg.r * 1.3); ctx.lineTo(-fg.r * 0.55, fg.r * 0.85); ctx.lineTo(-fg.r * 0.72, -fg.r * 0.3);
          ctx.closePath();
          ctx.fillStyle = "#c44dff"; ctx.fill();
          ctx.lineWidth = 4; ctx.strokeStyle = "#ffffff"; ctx.lineJoin = "round"; ctx.stroke();
          ctx.lineWidth = 1.4; ctx.strokeStyle = "rgba(5,6,15,.6)"; ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(0, -fg.r * 1.3); ctx.lineTo(fg.r * 0.3, 0); ctx.lineTo(0, fg.r * 1.3); ctx.lineTo(-fg.r * 0.3, 0);
          ctx.closePath();
          ctx.fillStyle = "#f0abfc"; ctx.fill();
          ctx.restore();
          ctx.save();
          ctx.font = "900 11px 'DotGothic16',sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          var flw = 52, flx = fg.x - flw / 2, fly = fg.y - fg.r - 26;
          ctx.fillStyle = "rgba(43,10,60,.92)"; ctx.fillRect(flx, fly, flw, 16);
          ctx.strokeStyle = "#e879f9"; ctx.lineWidth = 1.6; ctx.strokeRect(flx, fly, flw, 16);
          ctx.fillStyle = "#f5d0fe"; ctx.fillText("◆カケラ", fg.x, fly + 8.5);
          ctx.restore();
        });
        ctx.textBaseline = "alphabetic";
        // items
        G.items.forEach(function(it2){
          var def = ITEM_DEF[it2.type];
          var rr = it2.r * (1 + 0.1 * Math.sin(it2.pulse));
          ctx.save();
          ctx.strokeStyle = def.color; ctx.lineWidth = 3;
          ctx.shadowColor = def.color; ctx.shadowBlur = 14;
          ctx.strokeRect(it2.x - rr - 5, it2.y - rr - 5, (rr + 5) * 2, (rr + 5) * 2);
          ctx.fillStyle = "rgba(10,16,32,.92)";
          ctx.fillRect(it2.x - rr, it2.y - rr, rr * 2, rr * 2);
          ctx.shadowBlur = 0;
          ctx.font = "17px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(def.ic, it2.x, it2.y + 1);
          ctx.restore();
        });
        ctx.textBaseline = "alphabetic";
        // obstacles: amoeba blobs — squash, stretch and wobble as they drift down
        G.obstacles.forEach(function(o){
          var tNow = performance.now() / 1000;
          ctx.save();
          ctx.shadowColor = o.color; ctx.shadowBlur = 10;
          drawAmoeba(o.x + Math.sin(o.wob) * 2, o.y, o.r, o.color, tNow + o.frameSeed, o.frameSeed * 3, 0.22);
          ctx.restore();
        });
        // player trail: equipped こんせき (trail cosmetics) draw their own
        // shapes; otherwise a string of shrinking mini-blobs
        if (!G.crashed){
          var trEq = trails().equip;
          for (var t = p.trail.length - 1; t >= 3; t -= 2){
            var tp = p.trail[t], k = 1 - t / p.trail.length;
            if (trEq === "sparkle" && en().items.sparkle){
              ctx.save();
              ctx.globalAlpha = 0.85 * k + 0.15;
              ctx.fillStyle = t % 4 === 0 ? "#ffffff" : "#ffd23f";
              drawStarShape(tp.x, tp.y, 8 * k + 2.5, t * 0.7 + performance.now() / 300);
              ctx.fill();
              ctx.restore();
            } else if (trEq === "sakura" && trails().sakura){
              ctx.globalAlpha = 0.55 * k;
              ctx.fillStyle = "#ff9ecb";
              ctx.beginPath(); ctx.arc(tp.x, tp.y, 5.5 * k + 1.8, 0, Math.PI * 2); ctx.fill();
            } else if (trEq === "season" && trails().season){
              ctx.globalAlpha = 0.6 * k;
              ctx.fillStyle = "#7ef0ff";
              var ss2 = 6 * k + 2;
              ctx.fillRect(tp.x - ss2 / 2, tp.y - ss2 / 2, ss2, ss2);
            } else {
              ctx.globalAlpha = 0.25 * k;
              ctx.fillStyle = legendOwnedNow() ? "hsl(" + ((performance.now() / 6 + t * 24) % 360) + ",90%,72%)" : "#c7d0dd";
              ctx.beginPath(); ctx.arc(tp.x, tp.y, p.r * 0.8 * k + 2, 0, Math.PI * 2); ctx.fill();
            }
          }
          ctx.globalAlpha = 1;
        }
        // shield / grace / invuln rings
        if (!G.crashed && G.invuln <= 0){
          if (G.shieldCharges > 0){
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 10 + Math.sin(performance.now() / 80) * 2, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(46,230,168,.9)"; ctx.lineWidth = 2.5; ctx.stroke();
          } else if (G.grace > 0){
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 10, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(46,230,168,.35)"; ctx.lineWidth = 2; ctx.stroke();
          }
        }
        if (!G.crashed && G.barrierT > 0){
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 16 + Math.sin(performance.now() / 70) * 3, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(255,159,28,.95)"; ctx.lineWidth = 3.5; ctx.stroke();
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 22, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(255,210,63,.45)"; ctx.lineWidth = 2; ctx.stroke();
        }
        if (!G.crashed && G.invuln > 0){
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 12, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(255,255,255," + (0.35 + 0.3 * Math.sin(performance.now() / 60)) + ")";
          ctx.lineWidth = 2.5; ctx.stroke();
        }
        // player
        if (!G.crashed) drawPlayerBody(save.skin, p);
        // particles (pixel squares)
        G.parts.forEach(function(pt){
          ctx.globalAlpha = Math.max(pt.life / pt.max, 0);
          ctx.fillStyle = pt.color;
          ctx.fillRect(pt.x - pt.r, pt.y - pt.r, pt.r * 2, pt.r * 2);
        });
        ctx.globalAlpha = 1;
        // floaters
        G.floaters.forEach(function(f){
          ctx.globalAlpha = Math.max(f.life / f.max, 0);
          ctx.font = "700 " + f.size + "px 'DotGothic16',sans-serif";
          ctx.textAlign = "center";
          ctx.lineWidth = 4; ctx.strokeStyle = "rgba(3,6,14,.75)";
          ctx.strokeText(f.text, f.x, f.y);
          ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y);
        });
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      /* ----- HUD ----- */
      var lastHudScore = -1, lastChips = "", lastAtkStr = "";
      function updateHUD(){
        if (!G) return;
        var sc = Math.floor(G.score);
        if (sc !== lastHudScore){
          $("hud-score").textContent = sc.toLocaleString();
          lastHudScore = sc;
        }
        var endless = G.mode === "endless";
        $("hud-best").textContent = (endless ? Math.max(en().bestScore, sc) : G.mode === "ranked" ? Math.max(rk().best, sc) : Math.max(save.best, sc)).toLocaleString();
        var cb = $("combo-box");
        if (G.combo >= 2){
          cb.style.visibility = "visible";
          $("combo-num").textContent = G.combo;
        } else cb.style.visibility = "hidden";
        var t = Math.max(G.time, 0);
        var tt = $("timer-text");
        var fill = $("timer-fill");
        if (endless){
          // endless HUD: elapsed time counts UP, score, and a small mode label
          tt.textContent = fmtElapsed(G.elapsed);
          tt.classList.remove("danger");
          $("timer-label").textContent = "時間";
          $("phase-label").textContent = "🏃 エンドレス";
          fill.style.width = "100%";
          fill.classList.remove("danger", "mid");
          $("x2-badge").classList.toggle("on", G.x2T > 0);
          $("x2-badge").textContent = "アイテム ×2";
        } else {
          tt.textContent = t.toFixed(1);
          tt.classList.toggle("danger", t <= 10 && t > 0);
          $("timer-label").textContent = "残り";
          $("phase-label").textContent = t <= 10 && t > 0 ? "CLUTCH TIME — ×2" : "PHASE " + G.phase;
          fill.style.width = (t / G.total * 100) + "%";
          fill.classList.toggle("danger", t <= 10);
          fill.classList.toggle("mid", t > 10 && G.phase >= 3);
          $("x2-badge").classList.toggle("on", (t <= 10 && t > 0) || G.x2T > 0);
          $("x2-badge").textContent = G.x2T > 0 && t > 10 ? "アイテム ×2" : "🔥 CLUTCH TIME ×2";
        }
        // effect chips
        var chips = "";
        if (G.magnetT > 0) chips += '<span class="fx-chip magnet">🧲 <span class="num">' + G.magnetT.toFixed(1) + '</span></span>';
        if (G.slowT > 0) chips += '<span class="fx-chip slow">⏳ <span class="num">' + G.slowT.toFixed(1) + '</span></span>';
        if (G.x2T > 0) chips += '<span class="fx-chip x2">✖️ ×2 <span class="num">' + G.x2T.toFixed(1) + '</span></span>';
        if (G.barrierT > 0) chips += '<span class="fx-chip barrier">🔥 バリア <span class="num">' + G.barrierT.toFixed(1) + '</span></span>';
        if (G.shieldCharges > 0) chips += '<span class="fx-chip shield">🛡️ ×' + G.shieldCharges + '</span>';
        if (G.mode === "endless") chips += '<span class="fx-chip ecoin">⬡ エンドレスコイン <span class="num">' + (G.eCoinsRun || 0) + '</span></span>';
        if (G.legendGot > 0) chips += '<span class="fx-chip" style="background:rgba(150,40,190,.88)"><span class="frag-chip-ic">◆</span> カケラ <span class="num">' + lg().fragments + '/' + FRAGMENTS_NEED + '</span></span>';
        if (chips !== lastChips){ $("fx-chips").innerHTML = chips; lastChips = chips; }
        else if (chips) { $("fx-chips").innerHTML = chips; }
        var atkStr = G.attacksLeft + "/" + G.attacksObtained;
        if (atkStr !== lastAtkStr){ lastAtkStr = atkStr; updateAttackBtn(); }
      }

      /* ----- run end / result ----- */
      var lastRun = null;
      function endRun(crashed){
        if (!G || G.over) return;
        G.over = true; G.running = false;
        cancelAnimationFrame(G.raf);
        bgmStop();
        var lvGainedCapture = pendingLevels;
        while (pendingLevels > 0){ pendingLevels--; }  // level already counted; celebration skipped post-run
        var finalScore = Math.floor(G.score);
        var endBonus = Math.floor(finalScore / 100);
        var baseRunCoins = G.runCoins;
        G.runCoins += endBonus;
        // Score chest is part of the run-end reward: rolled and granted here,
        // automatically on death or time-up — there is no claim tap anywhere.
        var chestNow = chestFor(finalScore);
        var chestCoins = chestNow.min + Math.floor(Math.random() * (chestNow.max - chestNow.min + 1));
        var chestDoubled = false;
        if (save.pass){ chestCoins *= 2; chestDoubled = true; }
        var totalRunCoins = G.runCoins + chestCoins;
        var runMode = G.mode || "casual";
        // endless economy guard: same earning rate, hard cap of 300 coins per run
        var endlessCapped = false, rawRunCoins = totalRunCoins;
        if (runMode === "endless" && totalRunCoins > ENDLESS_COIN_CAP){ totalRunCoins = ENDLESS_COIN_CAP; endlessCapped = true; }
        save.coins += totalRunCoins;
        var eCoinsEarned = runMode === "endless" ? (G.eCoinsRun || 0) : 0;
        if (eCoinsEarned > 0) en().coins = (en().coins || 0) + eCoinsEarned;
        var lvGained = lvGainedCapture;
        var isRecord = false, ratingDeltaVal = 0, tierNote = "";
        if (G.maxCombo > (save.totMaxCombo || 0)) save.totMaxCombo = G.maxCombo;
        if (runMode === "ranked"){
          var rr2 = rk();
          var tierBefore = tierOf(rr2.rating);
          isRecord = finalScore > rr2.best && G.elapsed > 2;
          if (finalScore > rr2.best) rr2.best = finalScore;
          rr2.plays++;
          ratingDeltaVal = ratingDelta(finalScore);
          rr2.rating = Math.max(0, rr2.rating + ratingDeltaVal);
          var tierAfter = tierOf(rr2.rating);
          if (tierAfter.min > tierBefore.min) tierNote = tierAfter.name + " に ランクアップ！ 🎉";
          else if (tierAfter.min < tierBefore.min) tierNote = tierBefore.name + " から " + tierAfter.name + " に さがった…";
          rr2.lastDelta = ratingDeltaVal;
          rr2.lastNote = "まえの ランク戦： スコア " + finalScore.toLocaleString() + " ／ レーティング " + (ratingDeltaVal >= 0 ? "+" : "") + ratingDeltaVal + (tierNote ? " ／ " + tierNote : " ／ " + tierAfter.name + " のまま");
          save.plays++;
        } else if (runMode === "endless"){
          // endless records live in their own fields — the normal best is untouched
          isRecord = (finalScore > en().bestScore || Math.floor(G.elapsed) > Math.floor(en().bestTime)) && G.elapsed > 2;
          if (finalScore > en().bestScore) en().bestScore = finalScore;
          if (Math.floor(G.elapsed) > Math.floor(en().bestTime)) en().bestTime = Math.floor(G.elapsed);
          save.plays++;
          save.totNear += G.near; save.totStars += G.stars; save.totGold += G.goldStars;
          missionJustUp = checkMissionSet();
        } else {
          isRecord = finalScore > save.best && G.elapsed > 2;
          if (finalScore > save.best){ save.best = finalScore; save.bestRevived = revivesUsed > 0; }
          save.plays++;
          save.totNear += G.near; save.totStars += G.stars; save.totGold += G.goldStars;
          missionJustUp = checkMissionSet();
        }
        var missionWins = [];
        addRunToPeriods({ stars: G.stars, near: G.near, gold: G.goldStars, score: finalScore, maxCombo: G.maxCombo, clutchNear: G.clutchNear || 0, attacks: G.attacksUsed || 0, fragments: G.legendGot || 0 });
        missionWins = checkAllCompletions();
        // season points: 1 run = 10pt / mission clear = 20pt / daily challenge = 30pt
        seasonTierJustUp = 0;
        var missionWinCoins = missionWins.reduce(function(a, w){ return a + w.reward; }, 0);
        addSeasonPoints(10 + missionWins.reduce(function(a, w){ return a + (w.kind === "challenge" ? 30 : 20); }, 0));
        var tierUpNow = seasonTierJustUp; seasonTierJustUp = 0;
        // local-only run record: capped history (last 200), stays in this save
        var prevModeScore = stats().lastScore[runMode];
        var isFirstToday = stats().lastRunDate !== dateKey(new Date());
        stats().lastRunDate = dateKey(new Date());
        recordRun({ mode: runMode, diff: runMode === "ranked" ? "ranked" : (G.diffId || "normal"), secs: Math.floor(G.elapsed), cleared: runMode === "casual" && !crashed, crashed: !!crashed, score: finalScore, coins: totalRunCoins + missionWinCoins, near: G.near, combo: G.maxCombo, gal: naviChar().id, date: dateKey(new Date()) });
        stats().lastScore[runMode] = finalScore;
        var albumNewNow = checkAlbum();
        var boosts = [];
        if (G.attacksBought > 0) boosts.push("攻撃を ふやした ×" + G.attacksBought);
        if (G.usedItems && G.usedItems.length) boosts.push("ガチャアイテム（" + G.usedItems.join("・") + "）");
        if (revivesUsed > 0) boosts.push("コインで ふっかつ ×" + revivesUsed);
        if (runMode !== "ranked" && startShieldCharges() > 0) boosts.push("はじめの シールド ×" + startShieldCharges());
        if (runMode !== "ranked") boosts.push("スコアの倍率 ×" + permMult().toFixed(2));
        persist();
        var legendJust = !!lg().justUnlocked;
        if (legendJust){ lg().justUnlocked = false; persist(); }
        lastRun = {
          mode: runMode, levelsGained: lvGained, legendGot: G.legendGot || 0, legendJust: legendJust,
          score: finalScore, near: G.near, stars: G.stars, goldStars: G.goldStars,
          coins: totalRunCoins, baseCoins: baseRunCoins, endBonus: endBonus,
          chestCoins: chestCoins, chestName: chestNow.name, chestCls: chestNow.cls, chestExtra: chestNow.extra, chestDoubled: chestDoubled, xp: G.runXP,
          maxCombo: G.maxCombo, crashed: crashed, isRecord: isRecord,
          clutchNear: G.clutchNear || 0, clutchMaxCombo: G.clutchMaxCombo || 0,
          clutchHit: !!G.clutchHit, frenzyClean: !G.frenzyHit,
          ratingDelta: ratingDeltaVal, tierNote: tierNote,
          diffId: runMode === "ranked" ? "ranked" : (G.diffId || "normal"),
          diffLabel: runMode === "ranked" ? "ランク戦（みんな同じ）" : (DIFFS[G.diffId] ? DIFFS[G.diffId].label : "ふつう"),
          modifier: G.modifier || null, multAtStart: G.multAtStart || 1,
          maxScore: G.maxScore || SCORE_MAX_BASE,
          rate: G.maxScore ? finalScore / G.maxScore * 100 : 0,
          missionWins: missionWins,
          time: Math.floor(G.elapsed), newItems: (G.endlessNewItems || []).slice(),
          eCoins: eCoinsEarned, eCoinsTotal: en().coins || 0,
          coinCapped: endlessCapped, rawCoins: rawRunCoins,
          prevScore: (prevModeScore === undefined || prevModeScore === null) ? -1 : prevModeScore,
          tierUp: tierUpNow, albumNew: albumNewNow, firstToday: isFirstToday,
          boostsText: boosts.length ? boosts.join(" ／ ") : "なし",
          attacksLeft: G.attacksLeft, attacksObtained: G.attacksObtained, attacksBought: G.attacksBought,
          resumeTime: crashed ? Math.max(G.time, 0) + 10 : 10
        };
        renderHome();
        setTimeout(function(){ showResult(); }, crashed ? 150 : 350);
      }
      function chestFor(score){
        if (score >= 5200) return { key:"legend", name:"レジェンド宝箱", cls:"tier-legend", min:130, max:220, extra:"💎 ジェム ×3 も入っていた！" };
        if (score >= 3200) return { key:"gold",   name:"ゴールド宝箱",   cls:"tier-gold",   min:70,  max:130, extra:"" };
        if (score >= 1600) return { key:"silver", name:"シルバー宝箱",   cls:"tier-silver", min:35,  max:70,  extra:"" };
        return { key:"bronze", name:"ブロンズ宝箱", cls:"tier-bronze", min:15, max:35, extra:"" };
      }
      var countUpTimer = null;
      var coinCountTimer = null;
      function showResult(){
        showView("result");
        stats().resultsShown++; persist();
        // details start collapsed every time: the first thing seen is only
        // score / best-update / coins / one navigator line / the two big buttons
        var rdEl = $("result-details"); if (rdEl) rdEl.hidden = true;
        var rdBtn = $("btn-result-detail"); if (rdBtn){ rdBtn.setAttribute("aria-expanded", "false"); rdBtn.textContent = "くわしく見る ▾"; }
        $("result-cause").textContent = (lastRun.mode === "ranked" ? "🏆 ランク戦 " : lastRun.mode === "endless" ? "🏃 エンドレス " : "") + (lastRun.crashed ? "💥 ぶつかった…" : "⏰ 時間おわり！");
        $("new-record").classList.toggle("on", lastRun.isRecord);
        if (lastRun.isRecord) sfx.record();
        var rtEl = $("result-time");
        if (rtEl){
          rtEl.hidden = lastRun.mode !== "endless";
          if (lastRun.mode === "endless") $("result-time-v").textContent = fmtElapsed(lastRun.time);
        }
        var rbLabel = $("result-best-label");
        if (lastRun.mode === "endless"){
          if (rbLabel) rbLabel.textContent = "エンドレス ベスト（時間 " + fmtElapsed(en().bestTime) + "）";
          $("result-best").textContent = en().bestScore.toLocaleString();
        } else {
          if (rbLabel) rbLabel.textContent = "ベスト";
          $("result-best").textContent = (lastRun.mode === "ranked" ? rk().best : save.best).toLocaleString();
        }
        var eiEl = $("result-endless-items");
        if (eiEl) eiEl.innerHTML = "";
        var reEl = $("result-ecoin");
        if (reEl){
          var isEnd = lastRun.mode === "endless";
          reEl.hidden = !isEnd;
          if (isEnd){
            $("result-ecoin-amount").textContent = "+" + (lastRun.eCoins || 0);
            $("result-ecoin-total").textContent = (lastRun.eCoinsTotal || 0).toLocaleString();
          }
        }
        var recEl = $("result-ecoin-card");
        if (recEl){
          if (lastRun.mode === "endless"){
            recEl.hidden = false;
            recEl.innerHTML = '<span class="mc-tt">⬡ エンドレスコイン</span><span class="mc-ds">今回 +' + (lastRun.eCoins || 0) + ' まい（ひろった分 ＋ 1分ごとの +5）／ もっている ぜんぶで <b>' + (lastRun.eCoinsTotal || 0).toLocaleString() + ' まい</b>。ショップの「エンドレス限定」でだけ つかえる。ふつうの コインとは べつだよ。</span><span class="mc-ds">エンドレスでは カケラは 出ないよ。</span>';
          } else { recEl.hidden = true; recEl.innerHTML = ""; }
        }
        $("btn-again").textContent = lastRun.mode === "endless" ? "🔁 もう1回（エンドレス）" : "🔁 もう1回";
        // Run-end coins were already added to save.coins in endRun — display only, no claim action.
        $("result-coin-breakdown").innerHTML = "走って ひろった分 🪙 +" + (lastRun.baseCoins || 0).toLocaleString() + " ／ おわりボーナス 🪙 +" + lastRun.endBonus.toLocaleString() + "<br />" + '<span class="' + (lastRun.chestCls || "") + '">' + (lastRun.chestName || "スコア宝箱") + "</span> 🪙 +" + (lastRun.chestCoins || 0).toLocaleString() + (lastRun.chestDoubled ? "（パスで 2倍）" : "") + (lastRun.chestExtra ? "<br />" + lastRun.chestExtra : "") + (lastRun.coinCapped ? "<br />エンドレスの コインは 1回 さいだい 300 まで（ほんとうは 🪙 " + (lastRun.rawCoins || 0).toLocaleString() + " だった）" : "");
        $("result-coin-total").textContent = save.coins.toLocaleString();
        var coinEl = $("result-coin-amount"), coinFrom = 0, coinTo = lastRun.coins, coinT0 = performance.now();
        clearInterval(coinCountTimer);
        coinCountTimer = setInterval(function(){
          var ck = Math.min((performance.now() - coinT0) / 650, 1);
          coinEl.textContent = "+" + Math.floor(coinFrom + (coinTo - coinFrom) * (1 - Math.pow(1 - ck, 3))).toLocaleString();
          if (ck >= 1) clearInterval(coinCountTimer);
        }, 16);
        var coinCard = $("result-coin-reward");
        if (coinCard){ coinCard.classList.remove("pop"); void coinCard.offsetWidth; coinCard.classList.add("pop"); }
        if (lastRun.coins > 0) sfx.box();
        $("result-gain").innerHTML = '<span class="gx">XP +' + lastRun.xp + '</span>';
        $("st-near").innerHTML = lastRun.near + "<small>回</small>";
        $("st-combo").textContent = lastRun.maxCombo;
        $("st-star").innerHTML = (lastRun.stars + lastRun.goldStars) + "<small>個</small>" + (lastRun.goldStars ? '<div style="font-size:11px;color:var(--gold);font-weight:800">⭐金 ' + lastRun.goldStars + '</div>' : "");
        $("result-level").textContent = "Lv." + save.level;
        $("result-lvbonus").textContent = lastRun.mode === "ranked" ? "ランク戦： みんな同じ強さ（倍率 ×1.00）" : "スコアの倍率 ×" + permMult().toFixed(2);
        $("result-xpnext").textContent = "あと " + (xpNeed() - save.xp) + " XP";
        $("result-xpfill").style.width = Math.min(save.xp / xpNeed() * 100, 100) + "%";
        var el = $("final-score"), from = 0, to = lastRun.score, t0 = performance.now();
        clearInterval(countUpTimer);
        countUpTimer = setInterval(function(){
          var k = Math.min((performance.now() - t0) / 700, 1);
          el.textContent = Math.floor(from + (to - from) * (1 - Math.pow(1 - k, 3))).toLocaleString();
          if (k >= 1) clearInterval(countUpTimer);
        }, 16);
        if (missionJustUp){
          missionJustUp = false;
          setTimeout(function(){ toast("ミッション ぜんぶ クリア！ スコアの倍率が ×" + missionMult() + " に あがった"); }, 600);
        }
        renderMissions();
        renderLives();
        // the result screen carries exactly ONE short navigator line
        var rnEl = $("result-navi");
        if (rnEl){
          if (lastRun.levelsGained > 0) rnEl.innerHTML = naviCardHtml("result", ["レベルアップ！ おめでとう！"], "star");
          else if (lastRun.mode === "ranked") rnEl.innerHTML = naviCardHtml("result", [lastRun.tierNote ? lastRun.tierNote : "ランク戦 おつかれさま！"], lastRun.crashed ? "sad" : "cheer");
          else rnEl.innerHTML = naviCardHtml("result", [galResultLine()], lastRun.crashed ? "sad" : "cheer");
        }
        var rcEl = $("result-record-card");
        if (rcEl){
          var rcHtml = '<span class="mc-tt">📈 きろくとの くらべ方</span>';
          if (lastRun.mode === "endless"){
            rcHtml += '<span class="mc-ds">スコア： ' + (lastRun.score >= en().bestScore && lastRun.isRecord ? "ベスト更新！" : "ベストまで あと " + Math.max(0, en().bestScore - lastRun.score).toLocaleString() + " 点") + '</span>';
            rcHtml += '<span class="mc-ds">時間： ' + (lastRun.time >= Math.floor(en().bestTime) && lastRun.isRecord ? "ベストタイム更新！" : "ベストタイムまで あと " + Math.max(0, Math.floor(en().bestTime) - lastRun.time) + " 秒") + '</span>';
          } else {
            var bestForMode = lastRun.mode === "ranked" ? rk().best : save.best;
            rcHtml += '<span class="mc-ds">スコア： ' + (lastRun.isRecord ? "ベスト更新！" : "ベストまで あと " + Math.max(0, bestForMode - lastRun.score).toLocaleString() + " 点") + '</span>';
          }
          if (lastRun.prevScore >= 0){
            var dPrev = lastRun.score - lastRun.prevScore;
            rcHtml += '<span class="mc-ds">前回より ' + (dPrev >= 0 ? "+" : "−") + Math.abs(dPrev).toLocaleString() + ' 点</span>';
          } else {
            rcHtml += '<span class="mc-ds">前回の きろくは まだ ない（はじめての 記録）</span>';
          }
          rcEl.innerHTML = rcHtml;
        }
        var lgEl = $("result-legend");
        if (lgEl){
          if (lastRun.legendJust){
            lgEl.innerHTML = '<div class="legend-reveal"><div class="lr-k">◆ レジェンド かんせい ◆</div><div class="lr-t">👑 ' + curLegend().item.name + ' ゲット！</div><div class="lr-d">伝説のカケラ ' + FRAGMENTS_NEED + ' / ' + FRAGMENTS_NEED + ' あつまった！ 何回も あそんでくれて ありがとう。これは 見た目だけの アイテム。ランク戦の ルールは かわらないよ。「あつめたもの」の ページで いつでも 見られる。</div></div>';
            sfx.levelup();
          } else if (lastRun.legendGot > 0){
            lgEl.innerHTML = '<div class="mode-card"><span class="mc-tt">◆ 伝説のカケラ +' + lastRun.legendGot + ' 個</span><span class="mc-ds">いま ' + lg().fragments + ' / ' + FRAGMENTS_NEED + '（あと ' + (FRAGMENTS_NEED - lg().fragments) + ' 個）。すすみぐあいは セーブずみ。くわしくは「あつめたもの」の ページで。</span></div>';
          } else lgEl.innerHTML = "";
        }
        var mcEl = $("result-mode-card");
        if (mcEl){
          if (lastRun.mode === "ranked"){
            mcEl.innerHTML = '<span class="mc-tt">🏆 ランク戦（みんな同じ ルール）</span><span class="mc-ds">60秒 きっかり／みんな同じ強さ／攻撃は 追加で 買えない／コインで ふっかつ なし。レーティング ' + (lastRun.ratingDelta >= 0 ? "+" : "") + lastRun.ratingDelta + ' → ' + rk().rating + ' pt（' + tierOf(rk().rating).name + '）' + (lastRun.tierNote ? " ／ " + lastRun.tierNote : "") + '</span>';
          } else if (lastRun.mode === "endless"){
            mcEl.innerHTML = '<span class="mc-tt">🏃 エンドレスの 結果</span><span class="mc-ds">たえた時間 <b>' + fmtElapsed(lastRun.time) + '</b> ／ スコア <b>' + lastRun.score.toLocaleString() + '</b> 点 ／ コイン 🪙 +' + lastRun.coins.toLocaleString() + (lastRun.coinCapped ? "（1回 さいだい 300 まで）" : "") + ' ／ ⬡ エンドレスコイン +' + (lastRun.eCoins || 0) + ' まい（ぜんぶで ' + (lastRun.eCoinsTotal || 0).toLocaleString() + ' まい）。ふっかつと 攻撃の 追加購入は なし。シーズンポイント +10 も 入った。</span>';
          } else {
            mcEl.innerHTML = '<span class="mc-tt">🎮 今回 つかったもの</span><span class="mc-ds">ブースト： ' + lastRun.boostsText + '。この記録は ランク戦とは 別の ランキングに入る。</span>';
          }
        }
        var dfEl = $("result-diff-card");
        if (dfEl){
          if (lastRun.mode === "ranked"){
            dfEl.innerHTML = '<span class="mc-tt">🏆 ランク戦（みんな同じ ルール）</span><span class="mc-ds">レベルと 今週のボーナスは つかわれない。MAXは みんな同じ <b>' + lastRun.maxScore.toLocaleString() + '</b> pt ／ パーフェクトまで あと <b>' + Math.max(0, lastRun.maxScore - lastRun.score).toLocaleString() + '</b> pt</span>';
          } else if (lastRun.mode === "endless"){
            dfEl.innerHTML = '<span class="mc-tt">🎚️ レベル： ' + lastRun.diffLabel + '（エンドレス）</span><span class="mc-ds">レベルは はじめの 速さと すきまの 感じだけ。限定アイテムは ショップの「エンドレス限定」で エンドレスコインで 買うよ（どの レベルでも ねだんは 同じ）。今週のボーナスは ついていない。さいご10秒×2 も ない（かわりに 1分ごとに +300pt と エンドレスコイン +5）。エンドレスでは カケラは 出ないよ。</span>';
          } else {
            var mod = lastRun.modifier ? defById(MODIFIERS, lastRun.modifier) : null;
            dfEl.innerHTML = '<span class="mc-tt">🎚️ レベル： ' + lastRun.diffLabel + (mod ? " ・ " + mod.ic + " " + mod.name : "") + '</span><span class="mc-ds">MAXは どのレベルでも 同じ（星・金星・ゲートの数、点数、60秒、さいご10秒×2は 同じ）。</span><div class="clutch-grid"><div><span class="ck">スコア</span><span class="cv num">' + lastRun.score.toLocaleString() + '</span></div><div><span class="ck">MAX<br />（みんな同じ）</span><span class="cv num">' + lastRun.maxScore.toLocaleString() + '</span></div><div><span class="ck">パーフェクトまで</span><span class="cv num">あと ' + Math.max(0, lastRun.maxScore - lastRun.score).toLocaleString() + ' pt</span></div></div>';
          }
        }
        var rmEl = $("result-missions");
        if (rmEl){
          if (lastRun.missionWins && lastRun.missionWins.length){
            rmEl.innerHTML = '<div class="mode-card"><span class="mc-tt">🎯 ミッション クリア！（コインは もう入っている）</span>' + lastRun.missionWins.map(function(w){ return '<span class="mc-ds">✅ ' + w.label + " — 🪙 +" + w.reward + (w.capHit ? "（ごほうびは ここまで）" : "") + "</span>"; }).join("") + "</div>";
          } else rmEl.innerHTML = "";
        }
        var ccEl = $("result-clutch-card");
        if (ccEl){
          if (lastRun.mode === "endless"){
            var eCc = en(), balCc = eCc.coins || 0, ccLines = "";
            ["comet","sparkle","outfit"].forEach(function(k){
              var it2 = ENDLESS_ITEMS[k];
              if (eCc.items[k]) ccLines += '<span class="mc-ds">' + it2.ic + ' ' + it2.kind + '「' + it2.name + '」： もっている ✓</span>';
              else ccLines += '<span class="mc-ds">' + it2.ic + ' ' + it2.kind + '「' + it2.name + '」（⬡ ' + it2.price + ' まい）まで： ' + (balCc >= it2.price ? '<b>買えるよ！</b> ショップの「エンドレス限定」へ' : 'あと <b>' + (it2.price - balCc) + ' まい</b>（いま ' + balCc + ' まい）') + '</span>';
            });
            ccEl.innerHTML = '<span class="mc-tt">🏃 エンドレス限定ショップまで</span>' + ccLines + '<span class="mc-ds">エンドレスで あつめた コインで 買えるよ。エンドレスでは カケラは 出ないよ。</span>';
          } else {
            ccEl.innerHTML = '<span class="mc-tt">🔥 クラッチタイムの せいせき（さいごの10秒）</span><div class="clutch-grid"><div><span class="ck">ニアミス</span><span class="cv num">' + lastRun.clutchNear + '回</span></div><div><span class="ck">いちばん長い<br />コンボ</span><span class="cv num">' + lastRun.clutchMaxCombo + '</span></div><div><span class="ck">さいごまで ダメージなし</span><span class="cv">' + (lastRun.frenzyClean ? "できた ✓" : "ダメージあり") + '</span></div></div>';
          }
        }
        // revive offer: capped at 2 per run, cost escalates 150 -> 300 coins (Subway-style doubling pattern)
        var card = $("continue-card");
        var nearBest = save.best > 0 ? lastRun.score >= save.best * 0.55 : lastRun.score >= 1200;
        var show = lastRun.mode !== "ranked" && lastRun.mode !== "endless" && revivesUsed < 2 && !lastRun.isRecord && nearBest && lastRun.score >= 800;
        card.classList.toggle("on", show);
        if (show){
          $("btn-continue").textContent = "⏩ コイン " + reviveCost() + " で つづける（あと " + (2 - revivesUsed) + " 回まで）";
          if (lastRun.crashed){
            $("continue-title").textContent = "あと少しで ベスト更新だった…！";
            $("continue-desc").textContent = "つづけると スコアそのまま、時間＋10秒・シールドつきで ふっかつできる。ふっかつは 1回に 2回まで。ねだんは 150→300 コインと あがる。";
          } else {
            $("continue-title").textContent = "ベスト更新まで あと少し！";
            $("continue-desc").textContent = "つづけると スコアそのまま、おまけで 10秒 走れる。ふっかつは 1回に 2回まで。ねだんは 150→300 コインと あがる。";
          }
        }
        renderRankings();
        renderRanking($("rank-list-result"), lastRun.mode === "ranked" ? rk().best : save.best, lastRun.mode === "ranked" ? false : save.bestRevived);
        renderShop();
      }
      // No reward-box / claim handler: run-end coins (including the score chest)
      // are granted automatically in endRun for both death and time-up.

      /* ----- buttons ----- */
      /* ----- how-to guide: large navigator + white bubble, tap to advance.
         Opened ONLY manually from 図鑑・メモ — never before a run. ----- */
      var GUIDE_STEPS = [
        { expr:"happy", line:"はじめまして、ナビのミアだよ！ 指で ドラッグして、銀ボールを うごかそう" },
        { expr:"smile", line:"むらさきと 青緑の アメーバを よけて、水色の 星を あつめよう" },
        { expr:"cheer", line:"大きな 金星は BONUS！ 白い ふちと BONUS の 文字が 目印だよ" },
        { expr:"star",  line:"むらさきピンクの けっしょう は「伝説のカケラ」。ふつうの ランで 流れてきたら ひろってね。エンドレスでは 出ないよ。10個で レジェンド ゲット！" }
      ];
      var guideStep = 0;
      function renderGuideStep(){
        var st = GUIDE_STEPS[guideStep];
        var ga = $("guide-navi"); if (ga) ga.innerHTML = naviSvg(st.expr);
        var gname = $("guide-name"); if (gname) gname.textContent = naviName();
        var gl = $("guide-line"); if (gl) gl.textContent = st.line.replace("ミア", naviName());
        var gn = $("guide-next");
        if (gn) gn.textContent = guideStep < GUIDE_STEPS.length - 1 ? "▼ タップで次へ（" + (guideStep + 1) + " / " + GUIDE_STEPS.length + "）" : "";
        var ok = $("guide-ok");
        if (ok) ok.textContent = guideStep < GUIDE_STEPS.length - 1 ? "次へ ▶" : "わかった！ 閉じる";
      }
      function advanceGuide(){
        if (guideStep < GUIDE_STEPS.length - 1){ guideStep++; renderGuideStep(); audio(); return; }
        closeGuide();
      }
      function openGuide(){
        guideStep = 0;
        renderGuideStep();
        $("navi-guide").classList.add("on");
        audio();
      }
      function tryStartRun(mode){
        // Start is immediate: no guide or explanation is ever interposed —
        // straight to the countdown and the run, on the first play and
        // every restart. The guide opens only from 図鑑・メモ.
        if (mode !== "ranked" && mode !== "endless") mode = "casual";
        beginRun(mode);
      }
      function beginRun(mode){
        audio(); refreshLives();
        if (!publicMode() && save.lives <= 0){
          toast("ライフが ないよ。つぎに もどるまで あと " + fmtCountdown(livesNextMs()));
          openLivesSheetForce();
          return;
        }
        consumeLife(); renderAll();
        startRun(null, mode);
      }
      function closeGuide(){
        save.naviSeen = true; persist();
        $("navi-guide").classList.remove("on");
      }
      function openLivesSheetForce(){
        openSheet({
          ic:"❤️", title:"ライフが ないよ",
          desc:"ライフは さいだい5、1時間で 1つ もどる。つぎに もどるまで あと " + fmtCountdown(livesNextMs()) + "。待たずに ぜんぶ もどせる（モック）。走っている時の ふっかつは コイン150→300で、ライフとは べつ。",
          price:"¥160 → ❤️ ×5", buyLabel:"ライフを ぜんぶ もどしたことに する",
          onBuy: function(){ save.lives = LIVES_MAX; save.livesTs = Date.now(); persist(); renderAll(); toast("ライフ ぜんぶ もどった（モック）5 / 5"); }
        });
      }
      $("btn-attack").addEventListener("click", function(e){ e.stopPropagation(); useAttack(); });
      $("btn-buy-attack").addEventListener("click", function(){
        var cost = attackCost(preAttacks);
        if (cost === null){ toast("つぎの 攻撃は ここまで（×3）だよ"); return; }
        if (save.coins < cost){ openPackSheet(cost - save.coins, "攻撃 +1"); return; }
        openSheet({
          ic:"💥", title:"攻撃を ふやす（モック）",
          desc:"いま： つぎに 走る時の 攻撃 ×" + (1 + preAttacks) + "（ここまで ×3）。買うと つぎは ×" + (2 + preAttacks) + " で スタート。コインで 買う モックで、本物の お金は かからない。",
          price:"🪙 " + cost, buyLabel:"コインで 攻撃を +1",
          onBuy: function(){
            save.coins -= cost; trackSpend(cost); preAttacks++; persist(); renderAll();
            toast("つぎに 走る時の 攻撃は ×" + (1 + preAttacks) + "（モック）");
          }
        });
      });
      /* Title Start opens the pre-play popup only — it never starts a run
         by itself. The popup's プレイ開始 button closes the popup and goes
         straight to the countdown via tryStartRun. もう1回 (btn-again)
         keeps calling tryStartRun directly, with no popup in between. */
      function openPreplay(){ renderAll(); $("preplay-back").classList.add("on"); audio(); }
      function closePreplay(){ $("preplay-back").classList.remove("on"); }
      $("btn-play").addEventListener("click", openPreplay);
      $("btn-open-daily").addEventListener("click", function(){ closePreplay(); showView("daily"); renderAll(); });
      $("btn-open-growth").addEventListener("click", function(){ closePreplay(); showView("growth"); renderAll(); });
      $("btn-preplay-start").addEventListener("click", function(){ closePreplay(); tryStartRun(preplayMode === "endless" ? "endless" : "casual"); });
      Array.prototype.forEach.call(document.querySelectorAll("[data-mode-sel]"), function(b){
        b.addEventListener("click", function(){
          preplayMode = b.getAttribute("data-mode-sel") === "endless" ? "endless" : "normal";
          renderPreRun();
          toast(preplayMode === "endless" ? "モード： エンドレス（ぶつかるまで）" : "モード： 60びょう（いつもの）");
        });
      });
      $("btn-preplay-close").addEventListener("click", closePreplay);
      $("preplay-close-x").addEventListener("click", closePreplay);
      $("preplay-back").addEventListener("click", function(e){ if (e.target === this) closePreplay(); });
      Array.prototype.forEach.call(document.querySelectorAll("[data-diff]"), function(b){
        b.addEventListener("click", function(){
          save.difficulty = b.getAttribute("data-diff");
          persist(); renderPreRun();
          toast("レベル： " + DIFFS[save.difficulty].label + "（MAXは どのレベルも 同じ）");
        });
      });
      $("btn-again").addEventListener("click", function(){ stats().restarts++; persist(); tryStartRun(lastRun ? lastRun.mode : "casual"); });
      $("btn-share-score").addEventListener("click", function(){
        if (!lastRun) return;
        var rate = lastRun.mode === "endless" ? Math.min(1, lastRun.time / 180) : (lastRun.maxScore ? lastRun.score / lastRun.maxScore : 0);
        var filled = Math.round(rate * 10), squares = "";
        for (var i = 0; i < 10; i++) squares += i < filled ? "🟩" : (i === filled && rate > 0 ? "🟨" : "⬜");
        var txt = "ヨケルン 1minute ⭐" + lastRun.score.toLocaleString() + "点 " + squares + " ニアミス" + lastRun.near + "回 コンボ最大" + lastRun.maxCombo;
        if (lastRun.mode === "endless") txt += "\n🏃 エンドレス " + fmtElapsed(lastRun.time) + " たえた ／ ⬡ エンドレスコイン +" + (lastRun.eCoins || 0) + "まい ／ ベスト " + fmtElapsed(en().bestTime) + " ・ " + en().bestScore.toLocaleString() + "点";
        else txt += "\nベスト " + (lastRun.mode === "ranked" ? rk().best : save.best).toLocaleString() + "点";
        copyText(txt);
      });
      $("btn-result-detail").addEventListener("click", function(){
        var d = $("result-details"); if (!d) return;
        var open = d.hidden;
        d.hidden = !open;
        this.setAttribute("aria-expanded", open ? "true" : "false");
        this.textContent = open ? "とじる ▴" : "くわしく見る ▾";
      });
      $("btn-refill-lives").addEventListener("click", function(){ openLivesSheet(); });
      $("btn-status-reset").addEventListener("click", function(){
        save.status = { speed:0, magnet:0, luck:0, shield:0, score:0 }; persist(); renderAll();
        toast("ステータスを もどした（お金は いらない）。" + statusRemaining() + " pt ふやし直せる");
      });
      setInterval(function(){ refreshLives(); renderLives(); if (ensurePeriods()){ renderDaily(); renderPreRun(); } var tc2 = $("tourney-countdown"); if (tc2 && views.ranked.classList.contains("active")) tc2.textContent = tourneyCountdownText(); var fm2 = $("friend-my-lives"); if (fm2 && views.friend.classList.contains("active")) fm2.textContent = save.lives + " / " + LIVES_MAX + (save.lives >= LIVES_MAX ? "（まんたん）" : ""); var L3 = curLimited(); Array.prototype.forEach.call(document.querySelectorAll(".js-limited-cd"), function(el){ el.textContent = countdownText(L3.end); }); var LG3 = curLegend(); Array.prototype.forEach.call(document.querySelectorAll(".js-legend-cd"), function(el){ el.textContent = countdownText(LG3.end); }); }, 1000);
      $("btn-home").addEventListener("click", function(){ showView("home"); renderAll(); });
      $("btn-continue").addEventListener("click", function(){
        var cost = reviveCost();
        if (save.coins < cost){ openPackSheet(cost - save.coins, "つづける"); return; }
        openSheet({
          ic:"⏩", title:"つづける（コイン）",
          desc:"コイン " + cost + " で、スコアを そのままに して" + (lastRun.crashed ? "ふっかつ＋10秒 おまけ。" : "おまけで 10秒。") + "ふっかつは 1回に 2回まで。ねだんは 150→300 コインと あがる。",
          price:"🪙 " + cost, buyLabel:"コインで ふっかつする",
          onBuy: function(){
            save.coins -= cost; trackSpend(cost); revivesUsed++; persist(); renderAll();
            startRun({
              score: lastRun.score, near: lastRun.near, stars: lastRun.stars, goldStars: lastRun.goldStars,
              maxCombo: lastRun.maxCombo, time: Math.min(lastRun.resumeTime, RUN_TIME),
              attacksLeft: lastRun.attacksLeft, attacksObtained: lastRun.attacksObtained, attacksBought: lastRun.attacksBought
            });
            toast("ふっかつ！ シールドつきで もどった");
          }
        });
      });

      /* ================= GACHA (published odds, duplicates -> coins, no complete-set mechanics) ================= */
      var SKIN_GACHA_COST = 200, ITEM_GACHA_COST = 100;
      var SKIN_GACHA_POOL = [
        { id:"inferno", pct:5,  dup:300 },
        { id:"comet",   pct:10, dup:200 },
        { id:"phantom", pct:15, dup:150 },
        { id:"mint",    pct:20, dup:100 },
        { id:"grape",   pct:20, dup:100 },
        { id:"sakura",  pct:30, dup:100 }
      ];
      var ITEM_GACHA_POOL = [
        { id:"attack", pct:25, label:"攻撃チケット",     desc:"つぎに 走る時の 攻撃 +1" },
        { id:"shield", pct:25, label:"スタートシールド", desc:"つぎの はじめの シールド +1" },
        { id:"magnet", pct:20, label:"スタートマグネット", desc:"つぎの はじめ マグネット5秒" },
        { id:"x2",     pct:15, label:"スタート×2",       desc:"つぎの はじめ スコア×2 10秒" },
        { id:"upg",    pct:15, label:"ずっと つよくなる +1", desc:"どれか 1つが 1だんかい あがる" }
      ];
      function rollPool(pool){
        var r = Math.random() * 100, acc = 0;
        for (var i = 0; i < pool.length; i++){ acc += pool[i].pct; if (r < acc) return pool[i]; }
        return pool[pool.length - 1];
      }
      function balText(cost){
        if (save.coins >= cost) return "もっている " + save.coins.toLocaleString() + " → のこり " + (save.coins - cost).toLocaleString() + " コイン";
        return "もっている " + save.coins.toLocaleString() + "（あと " + (cost - save.coins).toLocaleString() + " たりない）";
      }
      function renderGacha(){
        var c1 = $("gacha-coins"); if (c1) c1.textContent = save.coins.toLocaleString();
        var c2 = $("shop-coins"); if (c2) c2.textContent = save.coins.toLocaleString();
        var sb = $("skin-gacha-balance");
        if (sb) sb.textContent = "1回（200）： " + balText(200) + " ／ 10回（2,000）： " + balText(2000);
        var ib = $("item-gacha-balance");
        if (ib) ib.textContent = "1回（100）： " + balText(100) + " ／ 10回（1,000）： " + balText(1000);
        var stEl = $("item-stock-line");
        if (stEl){
          var sk = save.itemStock || { attack:0, shield:0, magnet:0, x2:0 };
          stEl.textContent = "もっている アイテム： 攻撃チケット ×" + sk.attack + " ／ スタートシールド ×" + sk.shield + " ／ スタートマグネット ×" + sk.magnet + " ／ スタート×2 ×" + sk.x2 + "（つぎに 走る時、はじめに じどうで つかわれる）";
        }
      }
      function doGacha(kind, n){
        var cost = (kind === "skin" ? SKIN_GACHA_COST : kind === "navi" ? NAVI_GACHA_COST : ITEM_GACHA_COST) * n;
        var gname = kind === "skin" ? "スキンガチャ" : kind === "navi" ? "ナビ衣装ガチャ" : "アイテムガチャ";
        if (save.coins < cost){ openPackSheet(cost - save.coins, gname); return; }
        openSheet({
          ic:"🎰", title: gname + " " + n + "回",
          desc: "ぜんぶで " + cost.toLocaleString() + " コイン（モック）。もっている " + save.coins.toLocaleString() + " → 引いたあと のこり " + (save.coins - cost).toLocaleString() + " コイン。かくりつは このページに ぜんぶ 出ていて、引く前に 見られる。セットを そろえる タイプでは ない。",
          price: "🪙 " + cost.toLocaleString(), buyLabel: n + "回引く（モック）",
          onBuy: function(){
            save.coins -= cost; trackSpend(cost);
            var rows = [];
            for (var i = 0; i < n; i++){
              if (kind === "skin"){
                var it = rollPool(SKIN_GACHA_POOL);
                if (save.owned[it.id]){ save.coins += it.dup; rows.push({ name: SKINS[it.id].name, tag: "かぶり → コイン +" + it.dup, cls: "dup" }); }
                else { save.owned[it.id] = true; rows.push({ name: SKINS[it.id].name, tag: "NEW スキン ゲット！（見た目だけ）", cls: "new" }); }
              } else if (kind === "navi"){
                var it3 = rollPool(NAVI_GACHA_POOL);
                if (it3.id === "coin"){ save.coins += 150; rows.push({ name: "コイン +150", tag: "コインが そのまま 入った", cls: "new" }); }
                else {
                  var oName = ""; NAVI_OUTFITS.forEach(function(x){ if (x.id === it3.id) oName = x.name; });
                  if (nv().owned[it3.id]){ save.coins += it3.dup; rows.push({ name: "ナビ衣装「" + oName + "」", tag: "かぶり → コイン +" + it3.dup, cls: "dup" }); }
                  else { nv().owned[it3.id] = true; rows.push({ name: "ナビ衣装「" + oName + "」", tag: "NEW 衣装 ゲット！（見た目だけ）", cls: "new" }); }
                }
              } else {
                var it2 = rollPool(ITEM_GACHA_POOL);
                if (!save.itemStock) save.itemStock = { attack:0, shield:0, magnet:0, x2:0 };
                if (it2.id === "upg"){
                  var cand = UPGRADES.filter(function(u){ return save.upg[u.id] < u.prices.length; });
                  if (!cand.length){ save.coins += 200; rows.push({ name: "ずっと つよくなる +1", tag: "ぜんぶ MAX → コイン +200", cls: "dup" }); }
                  else { var u2 = cand[Math.floor(Math.random() * cand.length)]; save.upg[u2.id]++; rows.push({ name: u2.title + " Lv." + save.upg[u2.id], tag: "ずっと つよくなる +1", cls: "new" }); }
                } else {
                  save.itemStock[it2.id]++;
                  rows.push({ name: it2.label, tag: it2.desc + "（もっている ×" + save.itemStock[it2.id] + "）", cls: "new" });
                }
              }
            }
            persist(); sfx.box(); renderAll();
            var box = $("gacha-result");
            box.style.display = "block";
            box.innerHTML = '<div class="gr-head">🎉 結果（' + gname + " " + n + '回）</div>' + rows.map(function(r){
              return '<div class="gr-row ' + r.cls + '"><span>' + r.name + '</span><span class="gr-tag">' + r.tag + '</span></div>';
            }).join("") + '<p class="gr-note">もっている コイン： ' + save.coins.toLocaleString() + '（かぶり分も 入っている）</p>';
            naviGachaMsg = "結果が 出たよ！ " + rows[0].name + (n > 1 ? " ほか " + (n - 1) + " 件" : "") + "。衣装は ショップの「ナビの 衣装」で きがえ できるよ";
            box.scrollIntoView({ behavior:"smooth", block:"nearest" });
            renderNavi();
          }
        });
      }

      /* ================= SETTINGS ================= */
      function renderSettings(){
        if (!save.settings) save.settings = { sound:true, crt:true, vib:true };
        Array.prototype.forEach.call(document.querySelectorAll("[data-set]"), function(b){
          var k = b.getAttribute("data-set");
          b.textContent = save.settings[k] ? "ON" : "OFF";
          b.classList.toggle("off", !save.settings[k]);
        });
        var crt = document.querySelector(".crt");
        if (crt) crt.style.display = save.settings.crt ? "" : "none";
        // こうかい版モード toggle + フレンド入口の 表示切り替え
        var pt = $("btn-public-toggle");
        if (pt){
          var pon = publicMode();
          pt.textContent = pon ? "ON" : "OFF";
          pt.classList.toggle("off", !pon);
          pt.setAttribute("aria-pressed", pon ? "true" : "false");
        }
        var fb = document.querySelector('[data-nav="friend"]');
        if (fb) fb.style.display = publicMode() ? "none" : "";
        renderBgm();
      }

      /* ----- page navigation ----- */
      Array.prototype.forEach.call(document.querySelectorAll("[data-nav]"), function(b){
        b.addEventListener("click", function(){ var tgt = b.getAttribute("data-nav"); audio(); if (tgt === "friend" && publicMode()) return; if (tgt === "friend") enterFriendPage(); showView(tgt); renderAll(); });
      });
      $("btn-public-toggle").addEventListener("click", function(){
        if (!save.settings) save.settings = { sound:true, crt:true, vib:true, bgm:"pop", public:false };
        save.settings.public = !save.settings.public; persist(); renderAll();
        toast(save.settings.public
          ? "こうかい版モード ON： ライフは むげん・お金の画面と フレンドは 出ないよ"
          : "こうかい版モード OFF： いつもの 設定に もどったよ");
        if (save.settings.public) sfx.buy();
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-back-preplay]"), function(b){
        b.addEventListener("click", function(){ showView("home"); openPreplay(); });
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-back]"), function(b){
        b.addEventListener("click", function(){ showView("home"); renderAll(); });
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-set]"), function(b){
        b.addEventListener("click", function(){
          var k = b.getAttribute("data-set");
          if (!save.settings) save.settings = { sound:true, crt:true, vib:true };
          save.settings[k] = !save.settings[k]; persist(); renderSettings();
          if (k === "sound" && !save.settings.sound) bgmStop();
          var label = k === "sound" ? "サウンド" : k === "crt" ? "CRTがめん" : "バイブレーション";
          toast(label + " を " + (save.settings[k] ? "ON" : "OFF") + " にしました");
          if (save.settings[k]) sfx.buy();
        });
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-bgm]"), function(b){
        b.addEventListener("click", function(){
          var id = b.getAttribute("data-bgm");
          if (!save.settings) save.settings = { sound:true, crt:true, vib:true, bgm:"pop" };
          save.settings.bgm = id; persist(); renderBgm(); renderPreRun();
          if (id === "off"){ bgmStop(); toast("おんがく： オフ（効果音だけ 出るよ）"); return; }
          if (!save.settings.sound){ toast("サウンドが OFFだから 音は 出ないよ"); return; }
          bgmPlay(true);
          toast("おんがく： " + BGM_TRACKS[id].name + "（試し聞き中）");
        });
      });
      $("btn-request-lives").addEventListener("click", function(){
        var f = fr();
        if (f.pending){ toast("もう リクエスト ずみだよ"); return; }
        f.pending = true; persist(); sfx.item(); renderAll();
        toast("フレンドに ライフを リクエストした（モック）— つぎに このページを 開くと とどくよ");
      });
      $("btn-play-ranked").addEventListener("click", function(){ tryStartRun("ranked"); });
      $("btn-season-pass").addEventListener("click", function(){
        if (publicMode()) return;   // こうかい版モード: ¥の購入画面は 出さない
        var r = rk();
        if (r.seasonPass){ toast("シーズンパスは もう つかっている（見た目だけ）"); return; }
        openSheet({
          ic:"🎫", title:"シーズンパス（見た目だけ）",
          desc:"大会だけの 軌跡や フレームなど、見た目だけの とくてん。強さ・スコア・ランクは かわらない。ねだんは 買う前に 見られて、ぜんぶ ¥480 以下。",
          price:"¥480", buyLabel:"シーズンパスを 買ったことに する",
          onBuy: function(){ rk().seasonPass = true; persist(); renderAll(); toast("シーズンパスが つかえるように なった（モック）— とくてんは 見た目だけ"); }
        });
      });
      $("guide-ok").addEventListener("click", advanceGuide);
      var ogBtn = $("btn-open-guide"); if (ogBtn) ogBtn.addEventListener("click", function(){ openGuide(); });
      $("guide-skip").addEventListener("click", closeGuide);
      $("guide-close").addEventListener("click", closeGuide);
      $("guide-bubble").addEventListener("click", advanceGuide);
      document.addEventListener("click", function(e){
        var t = e.target;
        var b = t && t.closest ? t.closest("[data-navi-dismiss]") : null;
        if (!b) return;
        naviDismissed[b.getAttribute("data-navi-dismiss")] = true;
        var card = b.parentElement;
        if (card) card.style.display = "none";
      });
      // Mia speech bubble: tap to advance to the next line (1-2 lines per card)
      document.addEventListener("click", function(e){
        var t = e.target;
        var b = t && t.closest ? t.closest("[data-navi-advance]") : null;
        if (!b) return;
        var c = naviCards[b.getAttribute("data-navi-advance")];
        if (!c || c.idx >= c.lines.length - 1) return;
        c.idx++;
        var lineEl = b.querySelector(".navi-line");
        if (lineEl) lineEl.textContent = c.lines[c.idx];
        var nextEl = b.querySelector(".navi-next");
        if (c.idx >= c.lines.length - 1){
          if (nextEl) nextEl.remove();
          b.removeAttribute("data-navi-advance");
        } else if (nextEl){
          nextEl.textContent = "▼ タップで次へ（" + (c.idx + 1) + " / " + c.lines.length + "）";
        }
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-gacha]"), function(b){
        b.addEventListener("click", function(){ doGacha(b.getAttribute("data-gacha"), parseInt(b.getAttribute("data-n"), 10)); });
      });
      var resetArmed = false;
      $("btn-reset-save").addEventListener("click", function(){
        if (!resetArmed){
          resetArmed = true; this.textContent = "本当に けす？ もう一度 タップ";
          var self = this;
          setTimeout(function(){ resetArmed = false; self.textContent = "リセット"; }, 3000);
          return;
        }
        try { localStorage.removeItem(SAVE_KEY); } catch(e){}
        save = defaultSave(); persist();
        resetArmed = false; this.textContent = "リセット";
        renderAll(); toast("セーブデータを けした");
      });

      /* ----- init ----- */
      refreshLives();
      ensureSeason();
      checkAlbum();
      renderAll();
    