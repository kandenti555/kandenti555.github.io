    "use strict";
    /* =========================================================
       すみ忍ランナー
       実装方針（調査レポート準拠）:
       - 物理は60Hz固定ステップ + accumulator(0.25sクランプ) + 描画補間 [Gaffer]
       - コースはチャンク制: 入口/出口は平地で統一、難度タグ+段階開放、
         shuffle bag + クールダウン、休息は6–9チャンクのランダム間隔 (第18次)
       - 速度は反応猶予 T=(960-211)/速度 が 0.4s を割らない範囲に制限 (構図C: 先読み749px)
       - trauma方式シェイク (shake = trauma^2)、ヒットストップはイベント別
       ========================================================= */
    var W = 960, H = 540;
    var GROUND_Y = 421;            // 構図C: 地面ラインは画面高さの約78% (0.78*540)
    var PLAYER_X = 211;            // 構図C: 左から約22% — 右に広い先読みスペースを確保
    var VIEW_AHEAD = W - PLAYER_X; // 749px (先読み距離)
    var GRAV = 2600;
    var JUMP_VEL = 895;
    var SPEED_START = 330, SPEED_MAX = 960; // 1周目の上限 (第21次: 880→960)。T(960)=749/960=0.78s
    /* 周回難易度 (第14次・仕様E／第21次で上限を引き上げ): 景色は1600mで1周し、
       周回ごとに速度上限を +40px/sずつ引き上げる (上限1120px/sで頭打ち。
       T(1120)=0.67sで反応猶予は十分残る)。検証系はその地点の周回上限を前提に判定する */
    var LAP_M = 1600; // 景色1周の距離 (竹林300+岩場400+夕景500+月夜400)
    function lapAt(dist) { return Math.floor(Math.max(0, dist) / LAP_M); } // 0=1周目
    function speedCapAt(worldX) {
      var lap = lapAt(worldX / PX_PER_M);
      return Math.min(SPEED_MAX + 40 * lap, 1120);
    }
    /* 落下岩の落下プラン (第23次で画面座標基準に是正): 第22次は「プレイヤー
       からの距離」で測っていたため、高速帯では影の画面座標 (中心 = PLAYER_X
       211 + 距離 + 23) が論理幅960を大きく超え (1120px/sで1120)、影が画面に
       入るのが着地の約0.07秒前までずれ込んでいた。是正は画面座標で設計する。
       影の中心が画面右端 (960) に来る距離が EDGE=726px。幾何学の制約として、
       着地リード (landGap/v) ≥0.5秒を保つ限り実位置の影の可視時間は
       (726-landGap)/v に制限され、高速帯では0.3秒に届かない。そこで:
       (1) 予告影テレグラフ: 落下開始より前に prewarn 状態を置き、影と「!」を
           画面右端 (中心 ≤936) に先行表示する。実位置が画面に入り次第、影は
           実位置へ移る。テレグラフは全速度帯で着地の0.62秒前から表示する。
       (2) 落下開始の画面内保証: warn+fallT を (EDGE-landGap)/v 以下に収め、
           落下が始まる時点で岩本体 (左端の画面座標 = 211+距離) も影も画面内。
       (3) 着地リード landGap/v は約0.54–0.56秒、着地位置 (中心の画面座標
           = 234+landGap) は全速度帯で画面内、を従来どおり維持する。
       grav は落下距離300pxを fallT 秒で落ち切る重力 */
    var FALL_EDGE = 726; // 影の中心が画面右端 (960) に来るプレイヤーからの距離
    var FALL_VIS = 0.62; // テレグラフ (予告影) を着地の何秒前から出すか
    function fallPlan(v) {
      var landGap = clamp(v * 0.54, 185, 620);
      var room = (FALL_EDGE - landGap) / v; // 実位置の影が見えてから着地までの上限 (秒)
      var fallT = clamp(room * 0.92, 0.10, 0.40);
      var warn = clamp(room - fallT, 0.04, 0.30);
      var pre = Math.max(0, FALL_VIS - warn - fallT);
      var dur = pre + warn + fallT;
      return {
        gap: landGap + v * dur, landGap: landGap, dur: dur, pre: pre,
        warn: warn, fallT: fallT, grav: 600 / (fallT * fallT), lead: landGap / v
      };
    }
    window.__fallPlan = fallPlan; // 検証ハーネス用に公開する
    var STEP = 1 / 60;
    var COYOTE = 0.10;   // 目安: 二次資料レンジ 5-6f
    var BUFFER = 0.12;   // 目安: 5-8f
    var DASH_TIME = 0.17, DASH_CD = 1.15, DASH_BOOST = 2.05;
    var PX_PER_M = 48;

    var canvas = document.getElementById("game");
    var ctx = canvas.getContext("2d", { alpha: false });

    function mulberry32(seed) {
      var a = seed >>> 0;
      return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
    function lerp(a, b, t) { return a + (b - a) * t; }

    /* ---------------- チャンク定義 ----------------
       rel座標で部品を置く。全チャンク入口・出口は平地。
       kind: spike(竹槍) rock(岩) crate(木箱) fallrock(落下岩)
             feintrock(フェイント落下岩) gap(穴) plat(足場) orb(墨玉) */
    function C(name, diff, verbs, width, build, trap) {
      var parts = [];
      build({
        spike: function (x) { parts.push({ kind: "spike", dx: x, w: 36, h: 42 }); },
        rock: function (x, big) { parts.push({ kind: "rock", dx: x, w: big ? 64 : 52, h: big ? 50 : 42 }); },
        crate: function (x) { parts.push({ kind: "crate", dx: x, w: 46, h: 46 }); },
        fall: function (x) { parts.push({ kind: "fallrock", dx: x, w: 46, h: 44 }); },
        feint: function (x) { parts.push({ kind: "feintrock", dx: x, w: 46, h: 44 }); },
        gap: function (x, w) { parts.push({ kind: "gap", dx: x, w: w, h: 0 }); },
        plat: function (x, w, h) { parts.push({ kind: "plat", dx: x, w: w, h: h }); },
        orbs: function (list) { for (var i = 0; i < list.length; i++) parts.push({ kind: "orb", dx: list[i][0], dy: list[i][1] }); },
        orbLine: function (x0, x1, dy) { var l = []; for (var x = x0; x <= x1; x += 58) l.push([x, dy]); this.orbs(l); },
        orbArc: function (cx, dy) { this.orbs([[cx - 90, dy - 40], [cx - 45, dy - 95], [cx, dy - 115], [cx + 45, dy - 95], [cx + 90, dy - 40]]); },
        // 罠アイテム (トラップチャンク専用): 通常の到達検証では引き戻さず、専用検証 (verifyTrapChunk) で扱う
        torbs: function (list) { for (var i = 0; i < list.length; i++) parts.push({ kind: "orb", dx: list[i][0], dy: list[i][1], trap: true }); }
      });
      return { name: name, diff: diff, verbs: verbs, width: width, parts: parts, trap: trap || null };
    }
    var CHUNKS = [
      // --- easy (diff 1-2) ---
      C("平地と墨玉", 1, [], 760, function (b) { b.orbLine(200, 520, 34); }),
      C("竹槍ひとつ", 1, ["jump"], 820, function (b) { b.spike(392); b.orbArc(410, 60); }),
      C("岩ひとつ", 1, ["jump"], 820, function (b) { b.rock(400); b.orbLine(560, 730, 34); }),
      C("木箱ひとつ", 2, ["jump", "dash"], 840, function (b) { b.crate(420); b.orbLine(380, 560, 92); }),
      C("高台の墨玉", 2, ["jump"], 920, function (b) { b.plat(300, 280, 94); b.orbLine(330, 510, 140); b.orbLine(660, 780, 34); }),
      // --- medium (diff 3) ---
      C("竹槍ふたつ", 3, ["jump"], 1000, function (b) { b.spike(340); b.spike(724); b.orbArc(358, 60); }),
      C("小さな穴", 3, ["jump"], 880, function (b) { b.gap(370, 185); b.orbArc(462, 70); }),
      C("木箱ふたつ", 3, ["jump", "dash"], 1020, function (b) { b.crate(340); b.crate(770); b.orbLine(300, 480, 92); }),
      C("落ちてくる岩", 3, ["jump"], 920, function (b) { b.fall(500); b.orbLine(180, 360, 34); b.orbLine(640, 800, 34); }),
      C("足場か地の槍か", 3, ["jump"], 1020, function (b) { b.spike(452); b.plat(560, 300, 96); b.orbLine(590, 770, 142); }),
      // --- hard (diff 4-5) ---
      C("竹槍みっつ", 4, ["jump"], 1200, function (b) { b.spike(300); b.spike(652); b.spike(1004); }),
      C("大きな穴", 4, ["jump", "dash"], 1000, function (b) { b.gap(350, 300); b.orbs([[430, 120], [505, 150], [580, 120]]); }),
      C("箱と槍の複合", 4, ["jump", "dash"], 1080, function (b) { b.crate(330); b.spike(712); b.crate(900); b.orbArc(730, 60); }),
      C("岩つるべ落とし", 5, ["jump", "dash"], 1180, function (b) { b.fall(390); b.fall(820); b.orbLine(520, 690, 34); }),
      C("島わたり", 5, ["jump"], 1180, function (b) { b.gap(300, 175); b.gap(705, 175); b.orbLine(505, 640, 110); }),
      // --- 複合変種 (第14次・仕様E): 主に2周目以降の引き締め用 (難度5のプール)。
      // 間隔は既存の難度4–5チャンクと同等以上に空け、跳び越え可能性は従来設計の範囲内 ---
      C("槍箱の波", 5, ["jump", "dash"], 1240, function (b) { b.spike(300); b.crate(650); b.spike(1010); b.orbArc(668, 60); }),
      C("岩槍の連鎖", 5, ["jump"], 1220, function (b) { b.rock(310); b.spike(690); b.rock(1010); b.orbLine(430, 560, 34); }),
      C("箱槍箱の複合", 5, ["jump", "dash"], 1200, function (b) { b.crate(300); b.spike(660); b.crate(990); b.orbArc(678, 60); }),
      // --- 落とし穴 (新規): 狭=ジャンプ / 中=ジャンプ / 広=ジャンプ+ドロン。直前直後は平地で障害物を置かない ---
      C("落とし穴（狭）", 2, ["jump"], 920, function (b) { b.gap(390, 165); b.orbArc(472, 70); }),
      C("落とし穴（中）", 3, ["jump"], 1000, function (b) { b.gap(380, 250); b.orbArc(505, 80); }),
      C("落とし穴（広）", 4, ["jump", "dash"], 1140, function (b) { b.gap(360, 355); b.orbs([[450, 120], [535, 150], [620, 120]]); }),
      // --- 序盤プール拡充 (第18次・対策2): tier0 (diff 1–2) を6種→10種にし、
      // 冒頭の顔ぶれ自体を増やす。墨玉は控えめに置き (到達可能性は生成後に
      // 全件検証される)、静けさプールにも入る形 (障害物1個以下) を中心にした ---
      C("岩と低い墨玉", 1, ["jump"], 820, function (b) { b.rock(410); b.orbLine(180, 320, 34); }),
      C("竹槍と地の墨玉", 1, ["jump"], 840, function (b) { b.spike(430); b.orbLine(600, 760, 34); }),
      C("木箱と地の墨玉", 2, ["jump", "dash"], 860, function (b) { b.crate(430); b.orbLine(620, 780, 34); }),
      C("平地の小さな弧", 1, [], 800, function (b) { b.orbs([[300, 60], [390, 100], [480, 60]]); b.orbLine(600, 720, 34); }),
      // --- breather (第18次・対策3で3種のバリアント化): いずれも行動不要な
      // 平地＋墨玉のみで、休息としての機能は従来どおり。選出は pickChunk が
      // ランダム間隔で行う ---
      C("休息の平地", 0, [], 780, function (b) { b.orbLine(220, 560, 120); }),
      C("休息の平地・低", 0, [], 820, function (b) { b.orbLine(200, 540, 34); }),
      C("休息の小高台", 0, [], 900, function (b) { b.plat(320, 260, 84); b.orbLine(350, 530, 128); b.orbLine(660, 800, 34); })
    ];
    var BREATHERS = [CHUNKS.length - 3, CHUNKS.length - 2, CHUNKS.length - 1];
    var BREATHER = BREATHERS[0]; // 代表インデックス (監査集計の除外判定などに使う)
    var TIERS = [
      CHUNKS.map(function (c, i) { return i; }).filter(function (i) { return CHUNKS[i].diff >= 1 && CHUNKS[i].diff <= 2; }),
      CHUNKS.map(function (c, i) { return i; }).filter(function (i) { return CHUNKS[i].diff === 3; }),
      CHUNKS.map(function (c, i) { return i; }).filter(function (i) { return CHUNKS[i].diff >= 4; })
    ];

    /* ---------------- 悔しさトラップ (第9次) ----------------
       理不尽な死ではなく「欲張った自分が悪い」と感じる設計に限る。
       通常プール (TIERS) には混ぜず、専用タグ付きで別枠抽選する (pickChunk)。
       全種に共通する安全条件: 罠アイテムを取らない通常攻略の安全ルートが
       存在することを、生成時に同一物理シミュレーションで検証する
       (verifyTrapChunk)。保証できない配置は採用しない。 */
    var TRAP_IDX_BASE = 1000; // pickChunk が返すトラップ用インデックスの基数
    var TRAP_CHUNKS = [
      // 罠玉ライン: 竹槍の真上スレスレを低い墨玉列が通る。通常ジャンプの高い
      // 軌道で槍を越えるのが正解。墨玉を全部取ろうと低い軌道を通ると槍に触れる
      C("罠玉ライン", 3, ["jump"], 1020, function (b) {
        b.orbLine(120, 240, 34);
        b.spike(480);
        b.torbs([[376, 88], [428, 68], [480, 58], [532, 68], [584, 88]]);
        b.orbLine(720, 900, 34);
      }, "yoku"),
      // 高台の宝: 落とし穴の上空高くに墨玉列 (2段ジャンプ＋ドロンの
      // 連携でしか届かない)。取りに行かず通常ジャンプで穴を渡るのが正解。
      // 欲張って失敗すると穴に落ちる
      C("高台の宝", 4, ["jump", "dash"], 1160, function (b) {
        b.orbLine(120, 240, 34);
        b.gap(400, 240);
        b.torbs([[462, 262], [540, 288], [618, 262]]);
        b.orbLine(800, 980, 34);
      }, "takara"),
      // フェイント落下岩 (第24次で通常方式に統一): 上空で待機している岩が
      // 見えていて、通常の落下岩と同じ予告 (テレグラフ影＋warn 中の揺れ) の
      // あと、固定配置の位置に落ちて障害物として残る。狙い落下は廃止した
      C("揺れる落下岩", 3, ["jump"], 1000, function (b) {
        b.orbLine(140, 320, 34);
        b.feint(520);
        b.orbLine(700, 900, 34);
      }, "feint"),
      // 箱の向こう: 木箱の直後に竹槍。両方をまとめて跳び越えるのが正解。
      // 箱だけ見て低く跳ぶと槍に触れる (第14次で手裏剣廃止に伴い文言のみ更新)
      C("箱の向こう", 3, ["jump", "dash"], 1020, function (b) {
        b.crate(430);
        b.spike(492);
        b.orbs([[452, 100]]);
        b.orbLine(660, 880, 34);
      }, "hako")
    ];

    /* ---------------- パターンモード (第14次・仕様G) ----------------
       コース生成の「出方の傾向」を数チャンク単位で切り替える。モードは
       不規則な長さ (3–7チャンク) 続いたあと、同じモードの連続再選を避けて
       切り替わる。切替も含めすべてシード付き rng で決まるため再現性は維持。
       モードが変わってもチャンク自体は従来どおり入口・出口が平地で揃い、
       生成時の検証 (到達可能性・横断可能性・安全ルート) は全モード共通 */
    CHUNKS.forEach(function (c) {
      c.hasGap = false; c.obsN = 0; c.orbN = 0; c.hasPlat = false;
      for (var i = 0; i < c.parts.length; i++) {
        var p = c.parts[i];
        if (p.kind === "gap") c.hasGap = true;
        else if (p.kind === "orb") c.orbN++;
        else if (p.kind === "plat") c.hasPlat = true;
        else c.obsN++;
      }
    });
    var PATTERN_MODES = ["rush", "arc", "gaps", "trap", "calm"];
    /* プールは主タグ1つに寄せる (第18次・対策4): 各チャンクは優先順位
       (穴 → 障害物2個以上 → 墨玉の多さ/足場 → 易しさ) で決まる主タグの
       プールにだけ入り、プール同士は重ならない。休息 (diff 0) はどの
       プールにも入れない。trap は専用チャンク側で効かせるため空のまま */
    function primaryTag(c) {
      if (c.diff <= 0) return null;
      if (c.hasGap) return "gaps";
      if (c.obsN >= 2) return "rush";
      if (c.orbN >= 5 || c.hasPlat) return "arc";
      if (c.diff <= 2 && c.obsN <= 1) return "calm";
      return null;
    }
    var MODE_POOLS = { rush: [], arc: [], gaps: [], trap: [], calm: [] };
    CHUNKS.forEach(function (c, i) {
      var t = primaryTag(c);
      if (t) MODE_POOLS[t].push(i);
    });
    var patternMode = "", patternLeft = 0; // 現在のモードと残りチャンク数
    window.__patternMode = function () { return patternMode; };
    function rollPatternMode() {
      var next = patternMode;
      while (next === patternMode) next = PATTERN_MODES[(rng() * PATTERN_MODES.length) | 0];
      patternMode = next;
      patternLeft = 3 + ((rng() * 5) | 0); // 3–7チャンク続く (不規則)
      // 第19次: モード切替の画面表示 (第18次で追加) は Kanta の指示で撤去。
      // パターンモードの仕組み自体は従来どおり動作する
    }

    /* ---------------- 音 (手続き型合成) ---------------- */
    var AudioSys = {
      ctx: null, muted: false, bgmOn: false, gains: null, step: 0, nextTime: 0, timer: null,
      init: function () {
        if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain(); this.master.gain.value = 0.9;
        this.master.connect(this.ctx.destination);
      },
      // 反復音は ±2半音以内のピッチランダム、意味のある音は固定
      prand: function () { return Math.pow(2, ((Math.random() * 4 - 2) / 12)); },
      tone: function (f0, f1, dur, type, vol, randomize) {
        if (!this.ctx || this.muted) return;
        var t = this.ctx.currentTime;
        var m = randomize ? this.prand() : 1;
        var o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = type || "square";
        o.frequency.setValueAtTime(f0 * m, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(30, f1 * m), t + dur);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(g); g.connect(this.master);
        o.start(t); o.stop(t + dur + 0.02);
      },
      noise: function (dur, vol, freq, randomize) {
        if (!this.ctx || this.muted) return;
        var t = this.ctx.currentTime;
        var len = Math.max(1, (dur * this.ctx.sampleRate) | 0);
        var buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        var d = buf.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
        var src = this.ctx.createBufferSource(); src.buffer = buf;
        if (randomize) src.playbackRate.value = this.prand();
        var f = this.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = freq || 1200;
        var g = this.ctx.createGain(); g.gain.value = vol;
        src.connect(f); f.connect(g); g.connect(this.master);
        src.start(t);
      },
      jump: function () { this.tone(300, 660, 0.14, "square", 0.10, true); },
      jump2: function () { this.tone(440, 990, 0.13, "square", 0.10, true); }, // 2段ジャンプ: 1段目より高めで区別
      land: function () { this.noise(0.07, 0.12, 700, true); },
      orb: function () { this.tone(880, 1320, 0.09, "sine", 0.10, true); },
      near: function () { this.tone(1180, 1560, 0.10, "triangle", 0.13, true); },
      dash: function () { this.noise(0.20, 0.20, 2400, true); this.tone(180, 90, 0.16, "sawtooth", 0.05, true); },
      brk: function () { this.noise(0.16, 0.22, 1500, true); this.tone(140, 60, 0.12, "square", 0.10, true); },
      katonGet: function () { // 火遁取得 (第14次): 燃え上がるノイズ＋上昇音 (ピッチ固定)
        this.noise(0.28, 0.16, 900, false); this.tone(220, 660, 0.22, "sawtooth", 0.07, false);
      },
      katonFire: function () { this.noise(0.16, 0.13, 1600, false); this.tone(520, 980, 0.12, "sawtooth", 0.05, false); }, // 火の玉の発射 (第14次)
      katonHit: function () { this.noise(0.20, 0.20, 1200, false); this.tone(180, 60, 0.16, "square", 0.10, false); }, // 火遁の排除 (第14次)
      suitonGet: function () { this.noise(0.38, 0.16, 850, false); this.tone(240, 620, 0.34, "sine", 0.10, false); }, // 水遁取得 (第25次): 水しぶき＋うねる上昇音 (ピッチ固定)
      suitonHit: function () { this.noise(0.13, 0.13, 1050, false); this.tone(300, 150, 0.10, "sine", 0.05, false); }, // 波の押し流し (第25次)
      fuutonCast: function () { this.noise(0.42, 0.17, 2300, false); this.tone(190, 880, 0.32, "sine", 0.07, false); }, // 風遁発射 (第25次): 唸る風＋上昇音 (ピッチ固定)
      fuutonHit: function () { this.noise(0.10, 0.10, 1750, false); }, // 竜巻の巻き上げ (第25次)
      onigiri: function () { // おにぎり取得ジングル: 意味のある音なのでピッチ固定の3音アルペジオ
        if (!this.ctx || this.muted) return;
        var notes = [523.25, 659.25, 783.99], self = this;
        for (var i = 0; i < notes.length; i++) {
          (function (f, off) {
            var t = self.ctx.currentTime + off;
            var o = self.ctx.createOscillator(), g = self.ctx.createGain();
            o.type = "triangle"; o.frequency.setValueAtTime(f, t);
            g.gain.setValueAtTime(0.12, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
            o.connect(g); g.connect(self.master);
            o.start(t); o.stop(t + 0.18);
          })(notes[i], i * 0.07);
        }
      },
      missionClear: function () { // 巻物達成 (第12次): ピッチ固定の2音チャイム
        this.tone(659.25, 659.25, 0.10, "triangle", 0.11, false);
        var self = this;
        setTimeout(function () { self.tone(987.77, 987.77, 0.16, "triangle", 0.11, false); }, 80);
      },
      fullBlack: function () { // 真っ黒到達 (第12次): 低いドン＋墨が弾けるノイズ＋上昇3音 (ピッチ固定)
        if (!this.ctx || this.muted) return;
        this.tone(150, 55, 0.30, "sine", 0.22, false);
        this.noise(0.22, 0.16, 1100, false);
        var notes = [293.66, 440.00, 587.33], self = this;
        for (var i = 0; i < notes.length; i++) {
          (function (f, off) {
            var t = self.ctx.currentTime + off;
            var o = self.ctx.createOscillator(), g = self.ctx.createGain();
            o.type = "triangle"; o.frequency.setValueAtTime(f, t);
            g.gain.setValueAtTime(0.11, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
            o.connect(g); g.connect(self.master);
            o.start(t); o.stop(t + 0.20);
          })(notes[i], 0.05 + i * 0.07);
        }
      },
      bunshinGet: function () { this.tone(740, 1180, 0.10, "sine", 0.11, false); this.tone(1180, 1560, 0.08, "sine", 0.07, true); }, // 変わり身取得 (第12次)
      bunshinSave: function () { this.noise(0.25, 0.22, 900, false); this.tone(620, 110, 0.30, "sawtooth", 0.14, false); }, // 変わり身: 煙が弾ける (第12次)
      bump: function () { this.noise(0.12, 0.16, 900, false); },
      warn: function () { this.tone(980, 980, 0.09, "square", 0.09, false); },
      die: function () { this.tone(320, 40, 0.55, "sawtooth", 0.20, false); this.noise(0.4, 0.18, 800, false); },
      /* BGM: オリジナル和風ループ (Web Audio自己合成・外部音源なし)
         都節音階 (陰旋法: D Eb G A Bb) / 140 BPM / 16小節ループ
         (16分音符×256ステップ、継ぎ目なし)。先読みスケジューラ方式
         (40ms間隔で0.25秒先まで予約) で、フレーム落ちでも拍がずれない。
         垂直レイヤリング: L1=低音+太鼓 (ラン中常時) / L2=主旋律+風の音
         (中速から) / L3=装飾アルペジオ+締太鼓・拍子木 (高速時)。
         出し入れは Gain のクロスフェードのみで、再生自体は止めない */
      BPM: 140, TOTAL_STEPS: 256,
      DEG: { "1": 293.66, "2": 311.13, "3": 392.00, "4": 440.00, "5": 466.16, "6": 587.33, "7": 622.25, "8": 783.99, "9": 880.00 },
      LEAD: [
        "6...5...3...5...", "4.......3.2.....", "1...2...3...2...", "1...............",
        "3...4...5...4...", "6.......5...4...", "3...2...3...5...", "4...............",
        "8...6...5...6...", "7...6...5...3...", "5...4...3...4...", "3...............",
        "6...5...3...5...", "4...3...2...3...", "2...1...2...4...", "1..............."
      ],
      BASS_ROOT: [0, 0, 2, 0, 3, 2, 0, 0, 1, 0, 2, 3, 4, 3, 1, 0], // 小節ごとの根音 (音階配列の添字: 0=D 1=Eb 2=G 3=A 4=Bb)
      SCALE_LO: [146.83, 155.56, 196.00, 220.00, 233.08],
      SCALE_HI: [293.66, 311.13, 392.00, 440.00, 466.16, 587.33, 622.25, 783.99, 880.00, 1174.66],
      startBgm: function () {
        if (!this.ctx || this.bgmOn) return;
        this.bgmOn = true;
        var c = this.ctx;
        if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
        if (this.gains) { for (var d = 0; d < 3; d++) { try { this.gains[d].disconnect(); } catch (e) {} } }
        this.gains = [c.createGain(), c.createGain(), c.createGain()];
        this.gains[0].gain.value = 0.30; this.gains[1].gain.value = 0; this.gains[2].gain.value = 0;
        for (var i = 0; i < 3; i++) this.gains[i].connect(this.master);
        this.step = 0; this.nextTime = c.currentTime + 0.08;
        var self = this;
        this.timer = setInterval(function () { self.schedule(); }, 40);
      },
      schedule: function () {
        if (!this.ctx || !this.bgmOn) return;
        var spb = 60 / this.BPM / 4; // 16分音符
        while (this.nextTime < this.ctx.currentTime + 0.25) {
          this.playStep(this.step, this.nextTime);
          this.nextTime += spb; this.step = (this.step + 1) % this.TOTAL_STEPS;
        }
      },
      note: function (freq, t, dur, type, vol, layer) {
        var o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = type; o.frequency.value = freq;
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(g); g.connect(this.gains[layer]);
        o.start(t); o.stop(t + dur + 0.02);
      },
      // 琴のような撥弦: 減衰の速い三角波 + ノイズのアタック
      koto: function (freq, t, vol, layer, dur) {
        var c = this.ctx;
        var o = c.createOscillator(), g = c.createGain();
        o.type = "triangle"; o.frequency.value = freq;
        var d = dur || 0.30;
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + d);
        o.connect(g); g.connect(this.gains[layer]);
        o.start(t); o.stop(t + d + 0.02);
        this.noiseAt(t, 0.03, vol * 0.5, 3200, layer, "highpass");
      },
      // 太鼓: 低音サインのピッチ落下 + ノイズバースト
      taiko: function (t, vol) {
        var c = this.ctx;
        var o = c.createOscillator(), g = c.createGain();
        o.type = "sine";
        o.frequency.setValueAtTime(115, t);
        o.frequency.exponentialRampToValueAtTime(46, t + 0.22);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.30);
        o.connect(g); g.connect(this.gains[0]);
        o.start(t); o.stop(t + 0.32);
        this.noiseAt(t, 0.07, vol * 0.5, 420, 0, "lowpass");
      },
      // 風切り: 弱いノイズのうねり (偶数小節の頭にそっと入る)
      wind: function (t) {
        var c = this.ctx;
        var src = c.createBufferSource(); src.buffer = this.getNoiseBuf(); src.loop = true;
        var f = c.createBiquadFilter(); f.type = "bandpass"; f.Q.value = 1.4;
        f.frequency.setValueAtTime(480, t);
        f.frequency.linearRampToValueAtTime(920, t + 0.7);
        f.frequency.linearRampToValueAtTime(420, t + 1.5);
        var g = c.createGain();
        g.gain.setValueAtTime(0.0, t);
        g.gain.linearRampToValueAtTime(0.05, t + 0.45);
        g.gain.linearRampToValueAtTime(0.0, t + 1.5);
        src.connect(f); f.connect(g); g.connect(this.gains[1]);
        src.start(t); src.stop(t + 1.55);
      },
      getNoiseBuf: function () {
        if (this._nb) return this._nb;
        var len = this.ctx.sampleRate * 2;
        var buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        var d = buf.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this._nb = buf;
        return buf;
      },
      noiseAt: function (t, dur, vol, freq, layer, type) {
        var src = this.ctx.createBufferSource(); src.buffer = this.getNoiseBuf();
        src.playbackRate.value = 0.9 + Math.random() * 0.2;
        var f = this.ctx.createBiquadFilter(); f.type = type || "lowpass"; f.frequency.value = freq;
        if (f.type === "bandpass") f.Q.value = 6;
        var g = this.ctx.createGain();
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        src.connect(f); f.connect(g); g.connect(this.gains[layer]);
        src.start(t, Math.random() * 1.2); src.stop(t + dur + 0.02);
      },
      playStep: function (s, t) {
        var bar = (s / 16) | 0, st = s % 16;
        var root = this.BASS_ROOT[bar];
        var bassF = this.SCALE_LO[root];
        // --- L1: 低音 + 太鼓 (ラン中は常時) ---
        if (st === 0 || st === 8) this.note(bassF, t, 0.34, "triangle", 0.42, 0);
        if (st === 6 || st === 14) this.note(bassF, t, 0.16, "triangle", 0.26, 0);
        if (st === 12 && bar % 2 === 1) this.note(bassF * 1.4983, t, 0.18, "triangle", 0.24, 0);
        if (st === 0) this.taiko(t, 0.55);
        if (st === 8) this.taiko(t, 0.34);
        if (st === 14 && bar % 4 === 3) this.taiko(t, 0.26);
        // --- L2: 主旋律 (琴の撥弦) + 風の音 ---
        var ch = this.LEAD[bar].charAt(st);
        if (ch !== ".") this.koto(this.DEG[ch], t, 0.5, 1, 0.34);
        if (st === 0 && bar % 2 === 0) this.wind(t);
        // --- L3: 装飾アルペジオ + 締太鼓/拍子木 ---
        if (st % 2 === 0) {
          var pat = [0, 2, 4, 2, 1, 3, 4, 3];
          var idx = root + pat[(st / 2) | 0];
          if (idx < this.SCALE_HI.length) this.koto(this.SCALE_HI[idx], t, 0.15, 2, 0.13);
        }
        if (st % 4 === 2) this.noiseAt(t, 0.03, 0.30, 2300, 2, "bandpass"); // 締太鼓のチッ
        if (st === 0) { // 拍子木のカッカッ
          this.noiseAt(t, 0.025, 0.34, 2900, 2, "bandpass");
          this.noiseAt(t + 0.045, 0.025, 0.26, 2900, 2, "bandpass");
        }
      },
      setIntensity: function (v) {
        if (!this.ctx || !this.gains || !this.bgmOn) return;
        var t = this.ctx.currentTime;
        // 速度比で段階的に上げる: L2は中速 (比0.42→0.60で漸入)、L3は高速
        // (比0.68→0.86で漸入)。ゲインのみをクロスフェード (tau=0.8)
        this.gains[1].gain.setTargetAtTime(clamp((v - 0.42) / 0.18, 0, 1) * 0.30, t, 0.8);
        this.gains[2].gain.setTargetAtTime(clamp((v - 0.68) / 0.18, 0, 1) * 0.26, t, 0.8);
      },
      stopBgm: function () {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (!this.bgmOn) return;
        this.bgmOn = false;
        if (this.gains && this.ctx) {
          var gs = this.gains, t = this.ctx.currentTime;
          for (var i = 0; i < 3; i++) gs[i].gain.setTargetAtTime(0, t, 0.09); // 結果画面では即フェードアウト
          this.stopTimer = setTimeout(function () {
            for (var j = 0; j < 3; j++) { try { gs[j].disconnect(); } catch (e) {} }
          }, 450);
        }
      }
    };

    /* ---------------- ゲーム状態 ---------------- */
    var state = "title"; // title / playing / dying / pitfall / over / paused
    var rng = mulberry32(1);
    var seed = 1;
    var scroll, prevScroll, speed, elapsed;
    var player, parts, entities, nextChunkAt, chunkCount, recentChunks, bags;
    var score, nearCount, mult, maxMult, combo, trauma, hitstop, timeScale, slowTimer;
    var orbCount = 0, breakCount = 0, dashUseCount = 0, throwCount = 0; // P0: ラン内カウンタ (墨玉/破壊/ドロン/火遁の玉発射)
    var onigiriCount = 0, invincibleT = 0; // おにぎり (第11次): 取得数 / 無敵残り秒
    /* アイテム出現のランダム化 (第17次・仕様2): 固定間隔スケジュール
       (旧 next*At) を廃止し、チャンクごとの抽選に変更した。各アイテムは
       「前回の試行からの経過チャンク数 (since)」「最低間隔 min」「最大間隔
       max (ここまで来たら必ず試行するガード)」「min を過ぎた後の1チャンク
       あたりの当選確率 p」「序盤ガード firstAt (このチャンク数までは出ない)」
       を持つ。期待間隔は従来とほぼ同じに調整してある:
       おにぎり/火遁 = min8 + 幾何分布 (p=0.085) で期待約19–20チャンク
       (従来 15–25・平均20)、変わり身 = min12 + p=0.077 で期待約24–25
       チャンク (従来 20–30・平均25)。試行 (抽選に当たること) と配置成功は
       別で、到達可能性検証に落ちた場合は置かず、間隔もリセットされる
       (旧仕様の「次回を先に予約する」挙動と同じ)。判定は window.__itemAudit */
    function makeItemTimer(min, max, p, firstAt) {
      return { since: 0, min: min, max: max, p: p, firstAt: firstAt, tries: 0, placed: 0 };
    }
    var oniTimer = makeItemTimer(8, 34, 0.085, 14);
    var katTimer = makeItemTimer(8, 34, 0.085, 14);
    var bunTimer = makeItemTimer(12, 44, 0.077, 18);
    var suiTimer = makeItemTimer(8, 34, 0.085, 14); // 水遁 (第25次): 火遁と同じレア枠
    var fuuTimer = makeItemTimer(8, 34, 0.085, 14); // 風遁 (第25次): 火遁と同じレア枠
    window.__itemAudit = { onigiri: oniTimer, katon: katTimer, bunshin: bunTimer, suiton: suiTimer, fuuton: fuuTimer };
    /* 抽選: since は呼び出し側 (各 maybeAdd*) がチャンクごとに +1 する。
       序盤ガードと最低間隔の間は当たらない。最大間隔に達したら必ず試行 */
    function rollItem(t) {
      if (chunkCount < t.firstAt) return false;
      if (t.since < t.min) return false;
      if (t.since >= t.max || rng() < t.p) { t.since = 0; t.tries++; return true; }
      return false;
    }
    var mission = null, fullBlackDone = false; // 巻物チャレンジ / 真っ黒ご褒美 (第12次)
    var bunshinStock = 0, bunshinSaveCount = 0; // 変わり身の術 (第12次・第14次で改称): ストック(最大1) / 救済回数。出現抽選は bunTimer (第17次)
    var kawarimiFx = null, kawarimiT = 0; // 変わり身の発動演出 (第14次): 丸太 {wx, t} / 本体の点滅残り
    var katonBalls = 0, katonProjectiles = [], katonCd = 0, katonKillCount = 0; // 火遁 (第14次): 周回する火の玉の残数 / 追尾中の玉 / 発射クールダウン / 火遁での排除数。出現抽選は katTimer (第17次)
    var katonPickupCount = 0; // 火遁の取得回数 (第25次・3遁称号の判定用)
    /* 水遁・風遁 (第25次): 水遁は取得で50mの波乗り (波が終わるワールドxで
       管理し、終了地点の先が安全でない間は波を延長する)。風遁は取得した
       瞬間に竜巻を1発前方へ放つ (tornadoes が進みながら進路を消去する) */
    var suitonEndX = 0, suitonUses = 0, waveKillCount = 0, waveGapCount = 0; // 水遁: 波の終了x / 使用回数 / 波での消去数 / 波で越えた穴の数
    var fuutonUses = 0, fuutonKillCount = 0, fuutonMaxChain = 0, tornadoes = []; // 風遁: 使用回数 / 竜巻の総消去数 / 1発の最大消去数 / 発射中の竜巻
    var WAVE_M = 50; // 波乗りの距離 (m)
    function suitonOn() { return suitonEndX > 0 && scroll < suitonEndX; }
    var enemyKillCount = 0; // 敵忍者の撃破数 (第19次・称号判定用): 火遁での排除で数える。第25次からは波 (水遁) と竜巻 (風遁) での撃破も加算する
    var enemyTimer = 5; // 敵忍者 (第14次): 次の出現判定までの秒数
    var ENEMY_RUN = 150; // 敵忍者の自走速度 (px/s)。接近速度はスクロール+これ
    var bubbleT = 0, bubbleCd = 0; // ニアミス吹き出し (第12次): 表示残り / クールダウン
    var lastBandIdx = 0; // 距離帯 (第12次): 帯名表示の検出用
    var nightF = 0; // 月夜パレットの混合率 (描画側が毎フレーム更新。障害物等の縁の明るさ調整に使う)
    var missionBannerTimer = null, bandBannerTimer = null;
    var camY, prevCamY, runTime, deathReason, bestScore = 0, bestDist = 0;
    var shakeT = 0;
    var visualTime = 0;
    var ghostTrail = [];
    var curChunkName = "", curChunkDiff = 0;
    var lastTrapChunk = -99, lastTrapType = -1; // トラップの出現間隔管理 (第9次)
    var deathTrap = false; // このランの死亡がトラップチャンク内だったか (第9次)
    var pitTimer = 0, pitAlpha = 1, pitY0 = 0, pitScrollV = 0; // 落とし穴フェードアウト (第11次)
    var PIT_DUR = 0.7; // 落下確定から完全消滅までの秒数 (指定レンジ 0.6–0.9 の内側)
    var popups = [];

    function newBag(tier) {
      var arr = TIERS[tier].slice();
      for (var i = arr.length - 1; i > 0; i--) {
        var j = (rng() * (i + 1)) | 0;
        var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      }
      return arr;
    }
    /* ---------------- 選出系列の計測 (第18次・対策5) ----------------
       選出のたびに {通し番号, チャンク名, モード, tier, 種別, 直接選出か} を
       CHUNK_AUDIT (window.__chunkAudit) に残す。chunkAuditStats()
       (window.__chunkStats) が「同一チャンクの再出現間隔 (通常チャンクの
       系列内での平均・中央値)」と「モード適合率 (モードの主タグプールに
       属するチャンクが選ばれた割合。トラップモード中はトラップチャンクの
       選出を適合として数える)」を返す。変更前後の比較はこの2指標で行う */
    var CHUNK_AUDIT = [];
    window.__chunkAudit = CHUNK_AUDIT;
    function recordChunkAudit(idx, kind, tier, direct) {
      var ch = idx >= TRAP_IDX_BASE ? TRAP_CHUNKS[idx - TRAP_IDX_BASE] : CHUNKS[idx];
      CHUNK_AUDIT.push({ n: chunkCount, name: ch ? ch.name : "?", mode: patternMode || "none", tier: tier, kind: kind, idx: idx, direct: !!direct });
      if (CHUNK_AUDIT.length > 4000) CHUNK_AUDIT.shift();
    }
    function chunkAuditStats() {
      var norm = [];
      for (var i = 0; i < CHUNK_AUDIT.length; i++) if (CHUNK_AUDIT[i].kind === "normal") norm.push(CHUNK_AUDIT[i]);
      var last = {}, gaps = [];
      norm.forEach(function (a, pos) {
        if (last[a.idx] !== undefined) gaps.push(pos - last[a.idx]);
        last[a.idx] = pos;
      });
      gaps.sort(function (x, y) { return x - y; });
      var mean = gaps.length ? gaps.reduce(function (s, v) { return s + v; }, 0) / gaps.length : 0;
      var fitN = 0, fitD = 0;
      norm.forEach(function (a) {
        var pool = MODE_POOLS[a.mode];
        if (pool && pool.length) { fitD++; if (pool.indexOf(a.idx) >= 0) fitN++; }
      });
      CHUNK_AUDIT.forEach(function (a) {
        if (a.kind === "trap") { fitD++; if (a.mode === "trap") fitN++; }
      });
      return { picks: CHUNK_AUDIT.length, normal: norm.length,
               repeatMean: Math.round(mean * 10) / 10, repeatMedian: gaps.length ? gaps[(gaps.length / 2) | 0] : 0,
               modeFit: fitD ? Math.round(fitN / fitD * 1000) / 10 : null, modeFitN: fitN, modeFitD: fitD };
    }
    window.__chunkStats = chunkAuditStats;
    function recentIdx(n) { // 選出監査から直近 n 件のインデックスを返す (直接選出のクールダウン用)
      var out = [];
      for (var i = CHUNK_AUDIT.length - 1; i >= 0 && out.length < n; i--) out.push(CHUNK_AUDIT[i].idx);
      return out;
    }
    /* モードプールからの直接選出 (第18次・対策4): 確率0.9で袋引きではなく
       現在モードの主タグプールから直接選ぶ。序盤の段階開放は難度上限で守り
       (〜3チャンク: diff≤2 / 〜9チャンク: diff≤3)、クールダウンは直近5件→
       3件の順に緩める。プールが空 (トラップモード等)・候補なし・残り確率
       0.1の場合は -1 を返し、従来の袋引きに委ねる */
    function pickFromModePool() {
      var pool = MODE_POOLS[patternMode];
      if (!pool || !pool.length) return -1;
      if (rng() >= 0.9) return -1;
      var maxDiff = chunkCount <= 3 ? 2 : (chunkCount <= 9 ? 3 : 5);
      var cands = pool.filter(function (i) { return CHUNKS[i].diff <= maxDiff; });
      if (!cands.length) return -1;
      var ban5 = recentIdx(5), ban3 = recentIdx(3);
      var f = cands.filter(function (i) { return ban5.indexOf(i) < 0; });
      if (!f.length) f = cands.filter(function (i) { return ban3.indexOf(i) < 0; });
      if (!f.length) f = cands;
      return f[(rng() * f.length) | 0];
    }
    var nextBreatherAt = 7; // 次の休息チャンクの位置 (第18次・対策3: 6–9チャンクのランダム間隔)
    function pickChunk() {
      chunkCount++;
      // パターンモード (第14次・仕様G): 残数が尽きたら引き直す。残数の消費
      // (patternLeft--) は通常チャンクの選出時だけ行い、休息・トラップの
      // 選出では消費しない (第18次・対策4)
      if (patternLeft <= 0) rollPatternMode();
      // 周回の引き締め (第14次・仕様E): このチャンクが置かれる距離の周回
      var lapHere = lapAt(nextChunkAt / PX_PER_M);
      // 休息 (第18次・対策3): 5チャンク固定周期を廃止し、6–9チャンクの
      // ランダム間隔で、3種のバリアントから選ぶ。間隔が読めないだけで
      // 「行動不要な休み」という機能と頻度帯は従来と同水準
      if (chunkCount >= nextBreatherAt) {
        nextBreatherAt = chunkCount + 6 + ((rng() * 4) | 0);
        var bi = BREATHERS[(rng() * BREATHERS.length) | 0];
        recordChunkAudit(bi, "rest", -1, false);
        return bi;
      }
      // 悔しさトラップ (第9次): 序盤 (最初の5チャンク) には出さず、出現は
      // 間隔を空ける (通常8チャンク / トラップ寄りモード5 / 2周目以降6)。
      // 静けさモードでは出さない
      var trapGap = patternMode === "trap" ? 5 : (lapHere >= 1 ? 6 : 8);
      var trapProb = patternMode === "trap" ? 0.85 : (lapHere >= 1 ? 0.75 : 0.6);
      if (patternMode !== "calm" && chunkCount >= 6 && chunkCount - lastTrapChunk >= trapGap && rng() < trapProb) {
        lastTrapChunk = chunkCount;
        var ti = (rng() * TRAP_CHUNKS.length) | 0;
        if (ti === lastTrapType) ti = (ti + 1) % TRAP_CHUNKS.length; // 同種を続けない
        lastTrapType = ti;
        recentChunks.push(TRAP_IDX_BASE + ti);
        if (recentChunks.length > 3) recentChunks.shift();
        recordChunkAudit(TRAP_IDX_BASE + ti, "trap", -1, false);
        return TRAP_IDX_BASE + ti;
      }
      patternLeft--; // 通常チャンクの選出でだけモード残数を消費する
      var tier;
      var r = rng();
      if (chunkCount <= 3) tier = 0;
      else if (chunkCount <= 9) tier = r < 0.62 ? 0 : 1;
      else if (patternMode === "calm") tier = r < 0.55 ? 0 : (r < 0.9 ? 1 : 2);
      else if (patternMode === "rush") tier = r < 0.10 ? 0 : (r < 0.45 ? 1 : 2);
      else if (lapHere >= 1) tier = r < 0.12 ? 0 : (r < 0.52 ? 1 : 2); // 2周目以降は難しめに寄せる
      else tier = r < 0.22 ? 0 : (r < 0.62 ? 1 : 2);
      // モード直接選出 (第18次・対策4): 大半はモードプールから直接選ぶ
      var direct = pickFromModePool();
      if (direct >= 0) {
        recentChunks.push(direct);
        if (recentChunks.length > 3) recentChunks.shift();
        recordChunkAudit(direct, "normal", tier, true);
        return direct;
      }
      if (!bags[tier].length) bags[tier] = newBag(tier);
      var idx = bags[tier].shift();
      // クールダウン: 直近3つと同一なら袋の次と入れ替え
      if (recentChunks.indexOf(idx) >= 0 && bags[tier].length) {
        var alt = bags[tier].shift();
        bags[tier].push(idx);
        idx = alt;
      }
      recentChunks.push(idx);
      if (recentChunks.length > 3) recentChunks.shift();
      recordChunkAudit(idx, "normal", tier, false);
      return idx;
    }
    /* チャンク内ランダム化 (第18次・対策1): テンプレート (ch.parts) 自体は
       書き換えず、コピーにだけブレを加えてから配置を確定する。ブレはすべて
       シード付き rng から引く (再現性は維持)。検証ゲート (墨玉の到達可能性・
       穴の横断可能性・トラップの安全ルート・落下岩の着地点) は、このブレを
       適用した後の配置に対して従来どおり全件通す。
       - 障害物: 間隔の伸縮 (×0.92–1.08) ＋ dx に ±40–80px のジッター。
         入口・出口の平地 (端から160px／200px)、障害物同士の最小間隔150px、
         穴の前後170pxの空白は保ち、その内側でだけ動かす
       - 穴: dx ±30px・幅 ±20px (横断可能性は生成後に検証し、必要なら縮める)
       - 足場: dx ±40px
       - 墨玉: 列全体に形のバリエーションをデルタとして加える (そのまま (±10) /
         弧 (最大+70) / 階段 (±14–24ずつ) / 平坦化 (平均へ寄せる))。個々の
         到達可能性は生成後の検証・引き戻しが従来どおり担保する
       トラップチャンクは位置関係そのものが仕掛けのため対象外 (専用検証は不変) */
    function jitterParts(ch) {
      var src = ch.parts, out = [];
      for (var i = 0; i < src.length; i++) {
        var p = src[i];
        out.push({ kind: p.kind, dx: p.dx, w: p.w, h: p.h, dy: p.dy, trap: p.trap });
      }
      if (ch.trap) return out;
      var W2 = ch.width;
      var gaps = out.filter(function (q) { return q.kind === "gap"; });
      for (var gi = 0; gi < gaps.length; gi++) {
        var g = gaps[gi];
        g.dx = clamp(g.dx + Math.round((rng() * 2 - 1) * 30), 200, Math.max(200, W2 - 200 - g.w));
        g.w = clamp(g.w + Math.round((rng() * 2 - 1) * 20), 130, 380);
      }
      var obs = out.filter(function (q) {
        return q.kind === "spike" || q.kind === "rock" || q.kind === "crate" || q.kind === "fallrock" || q.kind === "feintrock";
      });
      obs.sort(function (a, b) { return a.dx - b.dx; });
      if (obs.length) {
        var anchor = obs[0].dx;
        var stretch = 0.92 + rng() * 0.16;
        for (var oi = 0; oi < obs.length; oi++) {
          var o = obs[oi];
          var mag = 40 + rng() * 40;
          var sgn = rng() < 0.5 ? -1 : 1;
          o.dx = Math.round(anchor + (o.dx - anchor) * stretch + sgn * mag);
        }
        for (var oj = 0; oj < obs.length; oj++) {
          var oo = obs[oj];
          oo.dx = clamp(oo.dx, 160, Math.max(160, W2 - 200));
          if (oj > 0 && oo.dx < obs[oj - 1].dx + 150) oo.dx = obs[oj - 1].dx + 150;
        }
        for (var ok2 = obs.length - 1; ok2 >= 0; ok2--) {
          var o2 = obs[ok2];
          if (o2.dx > W2 - 200) o2.dx = W2 - 200;
          if (ok2 < obs.length - 1 && o2.dx > obs[ok2 + 1].dx - 150) o2.dx = obs[ok2 + 1].dx - 150;
          if (o2.dx < 160) o2.dx = 160;
        }
        for (var om = 0; om < obs.length; om++) {
          var o3 = obs[om];
          for (var gm = 0; gm < gaps.length; gm++) {
            var gg = gaps[gm];
            if (o3.dx + (o3.w || 40) > gg.dx - 170 && o3.dx < gg.dx + gg.w + 170) {
              var leftPos = gg.dx - 170 - (o3.w || 40);
              var rightPos = gg.dx + gg.w + 170;
              o3.dx = Math.abs(o3.dx - leftPos) < Math.abs(o3.dx - rightPos) ? leftPos : rightPos;
              o3.dx = clamp(o3.dx, 160, Math.max(160, W2 - 200));
            }
          }
        }
      }
      for (var pi = 0; pi < out.length; pi++) {
        if (out[pi].kind === "plat") {
          out[pi].dx = clamp(out[pi].dx + Math.round((rng() * 2 - 1) * 40), 140, Math.max(140, W2 - 160 - out[pi].w));
        }
      }
      var orbs = out.filter(function (q) { return q.kind === "orb" && !q.trap; });
      if (orbs.length) {
        orbs.sort(function (a, b) { return a.dx - b.dx; });
        var shape = (rng() * 4) | 0; // 0=そのまま 1=弧 2=階段 3=平坦化
        var meanDy = orbs.reduce(function (s, q) { return s + (q.dy || 0); }, 0) / orbs.length;
        var peak = 30 + rng() * 40;
        var stepD = (14 + rng() * 10) * (rng() < 0.5 ? 1 : -1);
        for (var qi = 0; qi < orbs.length; qi++) {
          var q = orbs[qi], t = orbs.length > 1 ? qi / (orbs.length - 1) : 0.5, d = 0;
          if (shape === 0) d = (rng() * 2 - 1) * 10;
          else if (shape === 1) d = peak * Math.sin(Math.PI * t);
          else if (shape === 2) d = (qi - (orbs.length - 1) / 2) * stepD;
          else d = (meanDy - (q.dy || 0)) * 0.75 + (rng() * 2 - 1) * 6;
          q.dy = Math.round(clamp((q.dy || 0) + d, 30, 175));
          q.dx = clamp(q.dx + Math.round((rng() * 2 - 1) * 14), 60, W2 - 60);
        }
      }
      return out;
    }
    function spawnChunk() {
      var ci = pickChunk();
      var ch = ci >= TRAP_IDX_BASE ? TRAP_CHUNKS[ci - TRAP_IDX_BASE] : CHUNKS[ci];
      var base = nextChunkAt;
      var parts = jitterParts(ch); // 配置の確定前にチャンク内ランダム化を適用 (第18次・対策1)
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        var e = { kind: p.kind, x: base + p.dx, w: p.w, h: p.h, dy: p.dy || 0, trap: !!p.trap,
                  state: "idle", vy: 0, timer: 0, passed: false, nearDone: false, dead: false };
        entities.push(e);
      }
      chunkZones.push({ x0: base, x1: base + ch.width, name: ch.name, diff: ch.diff, verbs: ch.verbs, trap: ch.trap || null });
      verifyChunkOrbs(base, base + ch.width, ch.name); // 墨玉の到達可能性を生成直後に検証
      verifyChunkGaps(base, base + ch.width);          // 落とし穴は渡り切れることを検証
      if (ch.trap) verifyTrapChunk(base, base + ch.width, ch); // トラップは安全ルート＋罠アイテムを専用検証
      maybeAddOnigiri(base, ch); // おにぎり (第11次): レア配置・到達検証つき
      maybeAddBunshin(base, ch); // 変わり身 (第12次): レア配置・到達検証つき
      maybeAddKaton(base, ch); // 火遁 (第14次): レア配置・到達検証つき
      maybeAddSuiton(base, ch); // 水遁 (第25次): レア配置・到達検証つき
      maybeAddFuuton(base, ch); // 風遁 (第25次): レア配置・到達検証つき
      if (patternMode === "rush") maybeAddFallChain(base, ch); // 落下岩の連続落下 (第14次・仕様H／第15次で前方落下方式に追随)
      if (patternMode === "arc") maybeAddArcOrbs(base, ch); // 墨玉アークの追加列 (第14次・仕様G)
      if (!ch.trap) verifyFallrocks(base, base + ch.width); // 落下岩の着地点検証 (第15次): 穴・重なり・跳び越え可能性
      nextChunkAt += ch.width;
    }
    /* 連続落下 (第14次・仕様H／第15次で前方落下方式): ラッシュモードで
       落下岩を含むチャンクには、岩を1–2個追加する。第15次からは各岩が
       自機のはるか前方で時間差に落ちて障害物として並ぶ形になる。追加位置は
       「穴の上でなく、他の障害物と近すぎない」平地だけに置き、最終的な
       着地点の検証は verifyFallrocks が一括で行う */
    function maybeAddFallChain(base, ch) {
      if (ch.trap) return;
      var hasFall = false;
      for (var i = 0; i < entities.length; i++) {
        var e0 = entities[i];
        if ((e0.kind === "fallrock" || e0.kind === "feintrock") && e0.x >= base && e0.x < base + ch.width) { hasFall = true; break; }
      }
      if (!hasFall) return;
      var extra = 1 + ((rng() * 2) | 0); // 1–2個追加 (合計2–3個の連続落下)
      for (var k = 0; k < extra; k++) {
        var fx = base + 260 + k * 300 + ((rng() * 120) | 0);
        if (fx > base + ch.width - 120) continue;
        var clear = true;
        for (var j = 0; j < entities.length; j++) {
          var e = entities[j];
          if (e.x < fx - 170 || e.x > fx + 190) continue;
          if (e.kind === "gap" && fx + 46 > e.x - 60 && fx < e.x + e.w + 60) { clear = false; break; } // 穴の上・直前には置かない
          if ((e.kind === "spike" || e.kind === "rock" || e.kind === "crate" || e.kind === "fallrock" || e.kind === "feintrock" || e.kind === "plat") &&
              Math.abs(e.x - fx) < 170) { clear = false; break; }
        }
        if (!clear) continue;
        entities.push({ kind: "fallrock", x: fx, w: 46, h: 44, dy: 0, trap: false,
                        state: "idle", vy: 0, timer: 0, passed: false, nearDone: false, dead: false });
      }
    }
    /* 墨玉アーク追加列 (第14次・仕様G): アークモードの非トラップチャンクに
       ジャンプ軌道に沿う墨玉の弧を1列追加する。追加した墨玉も通常の
       到達可能性検証を通し、合格しないものは置かない */
    function maybeAddArcOrbs(base, ch) {
      if (ch.trap || ch.diff === 0) return;
      var cx = base + Math.floor(ch.width * (0.38 + rng() * 0.24));
      var added = [];
      var arcPts = [[-90, 74], [-45, 129], [0, 149], [45, 129], [90, 74]];
      for (var i = 0; i < arcPts.length; i++) {
        var o = { kind: "orb", x: cx + arcPts[i][0], dy: arcPts[i][1], w: 20, h: 20, trap: false,
                  state: "idle", vy: 0, timer: 0, passed: false, nearDone: false, dead: false };
        entities.push(o); added.push(o);
      }
      var solids = simSolids(base - 1250, base + ch.width + 420);
      for (var k = 0; k < added.length; k++) {
        var res = verifyOrb(added[k], solids);
        if (!res.ok) { relocateOrb(added[k], solids); res = verifyOrb(added[k], solids); }
        if (!res.ok) entities.splice(entities.indexOf(added[k]), 1);
        else { orbAuditCounts.total++; orbAuditCounts.ok++; ORB_AUDIT.push({ chunk: ch.name + "(arc)", x: Math.round(added[k].x), dy: added[k].dy, ok: true, margin: res.margin, mode: res.mode, relocated: false }); }
      }
    }
    var chunkZones = [];

    /* ---------------- 墨玉の到達可能性検証 (Phase 5) ----------------
       チャンク生成直後、そのチャンクの全墨玉に対して到達可能性を検証する。
       第一段: 到達包絡 (ジャンプ到達高さ＋足場) で明らかに届かない配置を弾く。
       第二段: ゲーム本体と同一の物理 (重力・頂点付近1/2・ドロン) で軌道
       シミュレーションし、ジャンプ開始フレームを振って最終判定する。
       合格条件: 取得できる軌道が存在し、開始タイミングの許容幅が ±3フレーム
       (連続7フレーム分) 以上あり、取得後に死亡せず着地できること。
       不合格の墨玉は到達範囲内へ自動で引き戻して再検証する。
       判定結果は ORB_AUDIT (window.__orbAudit) に全件残す。 */
    var ORB_AUDIT = [];
    var orbAuditCounts = { total: 0, ok: 0, relocated: 0, failed: 0 };
    window.__orbAudit = ORB_AUDIT;
    function simSolids(x0, x1) {
      var arr = [];
      for (var i = 0; i < entities.length; i++) {
        var e = entities[i];
        if (e.kind === "orb") continue;
        if (e.x + Math.max(e.w, 30) >= x0 && e.x <= x1) arr.push(e);
      }
      return arr;
    }
    function simGroundAt(solids, x) {
      for (var i = 0; i < solids.length; i++) {
        var e = solids[i];
        if (e.kind === "gap" && x > e.x + 6 && x < e.x + e.w - 6) return false;
      }
      return true;
    }
    function simSupportTop(solids, x, y) {
      var best = -1;
      for (var i = 0; i < solids.length; i++) {
        var e = solids[i];
        if (e.kind !== "plat" && e.kind !== "crate") continue;
        if (x > e.x - 6 && x < e.x + e.w + 6 && Math.abs(y - e.h) < 2 && e.h > best) best = e.h;
      }
      return best;
    }
    function simStartX(solids, orb, back) {
      var sx = orb.x - back;
      while (sx < orb.x - 120 && !simGroundAt(solids, sx)) sx += 12; // 開始点が穴の上なら手前の地面へ
      return sx;
    }
    /* 軌道シミュレーション: startX から速度 v で走り、jumpAt フレーム目に
       ジャンプ (全押し)、dashAt フレーム目にドロン (なければ -1)。
       墨玉を取得し、その後に安全に着地できたら true */
    function simTrajectory(solids, orb, startX, v, jumpAt, dashAt, jump2At) {
      var dt = STEP;
      var x = startX, y = 0, vy = 0, grounded = true, dashT = 0, collected = false, airJump = true;
      for (var f = 0; f < 300; f++) {
        if (f === jumpAt && grounded) { vy = JUMP_VEL; grounded = false; }
        else if (f === jump2At && !grounded && airJump) { vy = JUMP_VEL * 0.95; airJump = false; } // 2段ジャンプ (実ゲームと同一仕様: 空中1回・95%・着地でリセット)
        if (f === dashAt && dashT <= 0) { dashT = DASH_TIME; if (!grounded) vy = 0; }
        var cur = v * (dashT > 0 ? DASH_BOOST : 1);
        if (dashT > 0) dashT -= dt;
        x += cur * dt;
        if (!grounded) {
          var g = GRAV;
          if (Math.abs(vy) < 130) g *= 0.5; else if (vy < 0) g *= 1.18;
          if (dashT > 0) vy = 0; else vy -= g * dt;
          var prevY = y;
          y += vy * dt;
          if (vy <= 0) {
            for (var i = 0; i < solids.length; i++) {
              var e = solids[i];
              if ((e.kind === "plat" || e.kind === "crate") && x > e.x - 6 && x < e.x + e.w + 6) {
                if (prevY >= e.h - 1 && y <= e.h) { y = e.h; vy = 0; grounded = true; airJump = true; break; }
              }
            }
          }
          if (!grounded && y <= 0) {
            if (simGroundAt(solids, x)) { y = 0; vy = 0; grounded = true; airJump = true; }
            else if (y < -110) return false; // 穴に落下
          }
        } else {
          var sup = (y <= 0 && simGroundAt(solids, x)) || simSupportTop(solids, x, y) >= 0;
          if (!sup) grounded = false; // 足元が消えたら落下開始
        }
        if (!collected && Math.abs(orb.x + 10 - x) < 34 && Math.abs(orb.dy - (y + 18)) < 40) collected = true; // 取得中心は実ゲームと一致 (第9次: +24→+18)
        var pL = x - 8, pR = x + 8, pB = y, pT = y + 24; // 実ゲームの当たり判定と一致 (第9次: 幅22→16・高さ33→24、キャラ縮小に比例)
        for (var j = 0; j < solids.length; j++) {
          var o = solids[j];
          if (o.kind !== "spike" && o.kind !== "rock") continue;
          var oL = o.x + 6, oR = o.x + o.w - 6;
          var ox2 = Math.min(pR, oR) - Math.max(pL, oL);
          var oy2 = Math.min(pT, o.h) - Math.max(pB, 0);
          if (ox2 > 0 && oy2 > 0 && !(ox2 < 6 && oy2 < 6)) return false; // 致命障害物に接触
        }
        if (collected && grounded && x > orb.x + 130) return true;
        if (!collected && x > orb.x + 300) return false;
        if (collected && x > orb.x + 700) return false;
      }
      return collected && grounded;
    }
    function bestJumpWindow(solids, orb, startX, v) {
      var totalFrames = Math.floor((orb.x - startX) / (v * STEP));
      var n = Math.floor((totalFrames + 36) / 2) + 1;
      if (n < 1) n = 1;
      var okArr = new Array(n), i2, ja;
      // 取得後に障害物を跳び越える開始位置も含めるため、到達フレームより先まで振る。
      // 入力パターンは実ゲームの能力と一致させる。第1パス: 通常ジャンプ / +ドロン。
      // 第2パス (第1パスで合格しない場合のみ): +2段ジャンプ (頂点の前後2タイミング) /
      // 走り落ちてからの空中ジャンプ。どれか1つでも成功すれば到達可能とみなす
      for (i2 = 0; i2 < n; i2++) {
        ja = i2 * 2;
        okArr[i2] = simTrajectory(solids, orb, startX, v, ja, -1, -1)
          || simTrajectory(solids, orb, startX, v, ja, ja + 9, -1);
      }
      var best = longestRun(okArr) * 2;
      if (best >= 7) return best;
      for (i2 = 0; i2 < n; i2++) {
        if (okArr[i2]) continue;
        ja = i2 * 2;
        okArr[i2] = simTrajectory(solids, orb, startX, v, ja, -1, ja + 16)
          || simTrajectory(solids, orb, startX, v, ja, -1, ja + 24)
          || simTrajectory(solids, orb, startX, v, -1, -1, ja);
      }
      return longestRun(okArr) * 2; // 連続成功したジャンプ開始フレーム数 (2刻みの近似)
    }
    function longestRun(arr) {
      var best = 0, run = 0;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i]) { run++; if (run > best) best = run; }
        else run = 0;
      }
      return best;
    }
    function verifyOrb(orb, solids) {
      // 開始位置を複数試す (実プレイでは進入経路は連続で、開始点の置き方で
      // 判定が潰れないようにするため)。どれか1つで合格すれば到達可能
      var backs = [1100, 920, 740, 560];
      for (var b = 0; b < backs.length; b++) {
        var r = verifyOrbFrom(orb, solids, simStartX(solids, orb, backs[b]));
        if (r.ok) return r;
        if (b === 0) var firstRes = r;
      }
      return firstRes;
    }
    function verifyOrbFrom(orb, solids, startX) {
      if (simTrajectory(solids, orb, startX, 600, -1, -1, -1)) return { ok: true, margin: 999, mode: "run" };
      // 第一段: 到達包絡 — 2段ジャンプ込みの最高点 (約330) + 取得中心18 + 取得半径40 ≒ 388
      var support = 0;
      for (var i = 0; i < solids.length; i++) {
        var e = solids[i];
        if ((e.kind === "plat" || e.kind === "crate") && orb.x + 10 > e.x - 40 && orb.x + 10 < e.x + e.w + 40) support = Math.max(support, e.h);
      }
      if (orb.dy - support > 388) return { ok: false, margin: 0, mode: "envelope" };
      // 第二段: 物理シミュレーション (到達時点の推定速度と最高速度で判定。
      // 入力パターンには2段ジャンプも含む — bestJumpWindow 内で統合済み)。
      // 最高速度はその地点の周回上限 (第14次／第21次で引き上げ): 1周目は960。
      // 推定速度の係数630は SPEED_MAX(960) − SPEED_START(330) (第21次)
      var capHere = speedCapAt(orb.x);
      var vEst = capHere - 630 * Math.exp(-Math.max(0, orb.x) / 9000);
      if (vEst < SPEED_START) vEst = SPEED_START;
      var speeds = [vEst, capHere], bestMargin = 0;
      for (var s = 0; s < speeds.length; s++) {
        var m1 = bestJumpWindow(solids, orb, startX, speeds[s]);
        if (m1 > bestMargin) bestMargin = m1;
        if (bestMargin >= 7) break;
      }
      return { ok: bestMargin >= 7, margin: bestMargin, mode: bestMargin >= 7 ? "jump(+dash/2dan)" : "none" };
    }
    function relocateOrb(orb, solids) {
      for (var i = 0; i < solids.length; i++) {
        var e = solids[i];
        if (e.kind === "gap" && orb.x + 10 > e.x && orb.x + 10 < e.x + e.w) orb.x = e.x - 80; // 穴の手前の地面へ
      }
      // 地面より下 (dy<34) の墨玉は、地表を鏡面として上へ折り返す
      // (弧の形を保ったまま到達可能な高さへ戻す)
      if (orb.dy < 34) orb.dy = Math.min(150, 68 - orb.dy);
      if (orb.dy > 120) orb.dy = 120;
      if (orb.dy < 34) orb.dy = 34;
    }
    function verifyChunkOrbs(x0, x1, chunkName) {
      var orbs = [];
      for (var i = 0; i < entities.length; i++) {
        var e = entities[i];
        if (e.kind === "orb" && !e.trap && e.x >= x0 && e.x < x1) orbs.push(e); // 罠玉は専用検証 (verifyTrapChunk) で扱う
      }
      if (!orbs.length) return;
      var solids = simSolids(x0 - 1250, x1 + 420);
      for (var k = 0; k < orbs.length; k++) {
        var orb = orbs[k];
        var ox0 = orb.x, oy0 = orb.dy;
        var res = verifyOrb(orb, solids);
        var moved = false;
        if (!res.ok) {
          relocateOrb(orb, solids);
          moved = (orb.x !== ox0 || orb.dy !== oy0);
          res = verifyOrb(orb, solids);
          if (!res.ok) { // 最終手段1: 地面すれすれの確実な高さへ
            orb.dy = 34;
            relocateOrb(orb, solids);
            res = verifyOrb(orb, solids);
          }
          if (!res.ok) {
            // 最終手段2: 障害物の真上など、高さを変えても構造的に取れない位置では
            // 横へずらして再検証する (元の位置から近い順に試す)
            var shifts = [-140, 140, -260, 260, -380, 380];
            for (var si2 = 0; si2 < shifts.length && !res.ok; si2++) {
              orb.x = ox0 + shifts[si2];
              orb.dy = 34;
              res = verifyOrb(orb, solids);
              if (res.ok) moved = true;
            }
            if (!res.ok) { orb.x = ox0; orb.dy = 34; } // 尽きたら元のx・地表高に戻す
          }
        }
        orbAuditCounts.total++;
        if (res.ok) orbAuditCounts.ok++; else orbAuditCounts.failed++;
        if (moved) orbAuditCounts.relocated++;
        ORB_AUDIT.push({ chunk: chunkName, x: Math.round(orb.x), dy: orb.dy, ok: res.ok, margin: res.margin, mode: res.mode, relocated: moved });
      }
    }

    /* ---------------- おにぎり配置 (第11次／第17次で抽選化) ----------------
       出現はチャンクごとのランダム抽選 (rollItem / oniTimer)。序盤ガードと
       トラップチャンクには置かない原則は従来どおり。候補位置を最大3つ試し、
       墨玉と同じ到達可能性検証 (取得できる軌道があり、取得後に安全に
       着地できる) に合格した位置にだけ置く。合格しなければ今回は置かない */
    function maybeAddOnigiri(base, ch) {
      oniTimer.since++;
      if (ch.trap) return;
      if (!rollItem(oniTimer)) return;
      var offs = [0.32, 0.52, 0.72];
      for (var oi = 0; oi < offs.length; oi++) {
        var cand = { kind: "onigiri", x: base + Math.floor(ch.width * offs[oi]), w: 40, h: 40, dy: 60,
                     trap: false, state: "idle", vy: 0, timer: 0, passed: false, nearDone: false, dead: false };
        entities.push(cand);
        var solids = simSolids(base - 1250, base + ch.width + 420);
        var res = verifyOrb(cand, solids);
        if (res.ok) { oniTimer.placed++; return; }
        entities.splice(entities.indexOf(cand), 1);
      }
    }

    /* ---------------- 変わり身配置 (第12次・第14次で改称／第17次で抽選化) ----------------
       おにぎりと同じ流儀: 出現はチャンクごとのランダム抽選 (bunTimer)、
       序盤とトラップチャンクには置かない。候補位置を最大3つ試し、墨玉と
       同じ到達可能性検証に合格した位置にだけ置く */
    function maybeAddBunshin(base, ch) {
      bunTimer.since++;
      if (ch.trap) return;
      if (!rollItem(bunTimer)) return;
      var offs = [0.38, 0.58, 0.26];
      for (var oi = 0; oi < offs.length; oi++) {
        var cand = { kind: "bunshin", x: base + Math.floor(ch.width * offs[oi]), w: 40, h: 40, dy: 60,
                     trap: false, state: "idle", vy: 0, timer: 0, passed: false, nearDone: false, dead: false };
        entities.push(cand);
        var solids = simSolids(base - 1250, base + ch.width + 420);
        var res = verifyOrb(cand, solids);
        if (res.ok) { bunTimer.placed++; return; }
        entities.splice(entities.indexOf(cand), 1);
      }
    }

    /* ---------------- 火遁アイテム配置 (第14次・仕様D／第17次で抽選化) ----------------
       出現はチャンクごとのランダム抽選 (katTimer)。おにぎりと同じ流儀で、
       序盤とトラップチャンクには置かず、候補3か所から墨玉と同じ到達可能性
       検証に合格した位置にだけ置く */
    function maybeAddKaton(base, ch) {
      katTimer.since++;
      if (ch.trap) return;
      if (!rollItem(katTimer)) return;
      var offs = [0.44, 0.30, 0.64];
      for (var oi = 0; oi < offs.length; oi++) {
        var cand = { kind: "katon", x: base + Math.floor(ch.width * offs[oi]), w: 40, h: 40, dy: 60,
                     trap: false, state: "idle", vy: 0, timer: 0, passed: false, nearDone: false, dead: false };
        entities.push(cand);
        var solids = simSolids(base - 1250, base + ch.width + 420);
        var res = verifyOrb(cand, solids);
        if (res.ok) { katTimer.placed++; return; }
        entities.splice(entities.indexOf(cand), 1);
      }
    }

    /* ---------------- 水遁・風遁アイテム配置 (第25次) ----------------
       火遁とまったく同じ流儀: 出現はチャンクごとのランダム抽選 (火遁と
       同じレア枠 min8・max34・p=0.085・firstAt14)、序盤とトラップチャンク
       には置かず、候補3か所から墨玉と同じ到達可能性検証に合格した位置に
       だけ置く。検証に落ちればその回は置かず間隔はリセットされる */
    function maybeAddSuiton(base, ch) {
      suiTimer.since++;
      if (ch.trap) return;
      if (!rollItem(suiTimer)) return;
      var offs = [0.36, 0.56, 0.24];
      for (var oi = 0; oi < offs.length; oi++) {
        var cand = { kind: "suiton", x: base + Math.floor(ch.width * offs[oi]), w: 40, h: 40, dy: 60,
                     trap: false, state: "idle", vy: 0, timer: 0, passed: false, nearDone: false, dead: false };
        entities.push(cand);
        var solids = simSolids(base - 1250, base + ch.width + 420);
        var res = verifyOrb(cand, solids);
        if (res.ok) { suiTimer.placed++; return; }
        entities.splice(entities.indexOf(cand), 1);
      }
    }
    function maybeAddFuuton(base, ch) {
      fuuTimer.since++;
      if (ch.trap) return;
      if (!rollItem(fuuTimer)) return;
      var offs = [0.50, 0.34, 0.68];
      for (var oi = 0; oi < offs.length; oi++) {
        var cand = { kind: "fuuton", x: base + Math.floor(ch.width * offs[oi]), w: 40, h: 40, dy: 60,
                     trap: false, state: "idle", vy: 0, timer: 0, passed: false, nearDone: false, dead: false };
        entities.push(cand);
        var solids = simSolids(base - 1250, base + ch.width + 420);
        var res = verifyOrb(cand, solids);
        if (res.ok) { fuuTimer.placed++; return; }
        entities.splice(entities.indexOf(cand), 1);
      }
    }

    /* ---------------- 落とし穴の通過可能性検証 ----------------
       ゲーム本体と同一物理で、穴の手前からジャンプ開始フレームと
       ドロン有無を振ってシミュレーションし、穴の先に着地できる
       軌道が1つでもあれば合格。合格しない穴は幅を段階的に縮めて
       再検証する (入口側は固定し、出口側を手前に寄せる)。 */
    function simCrossGap(solids, gap, startX, v, jumpAt, dashAt, jump2At) {
      var dt = STEP;
      var x = startX, y = 0, vy = 0, grounded = true, dashT = 0, airJump = true;
      for (var f = 0; f < 320; f++) {
        if (f === jumpAt && grounded) { vy = JUMP_VEL; grounded = false; }
        else if (f === jump2At && !grounded && airJump) { vy = JUMP_VEL * 0.95; airJump = false; } // 2段ジャンプ (実ゲームと同一仕様)
        if (f === dashAt && dashT <= 0) { dashT = DASH_TIME; if (!grounded) vy = 0; }
        var cur = v * (dashT > 0 ? DASH_BOOST : 1);
        if (dashT > 0) dashT -= dt;
        x += cur * dt;
        if (!grounded) {
          var g = GRAV;
          if (Math.abs(vy) < 130) g *= 0.5; else if (vy < 0) g *= 1.18;
          if (dashT > 0) vy = 0; else vy -= g * dt;
          var prevY = y;
          y += vy * dt;
          if (vy <= 0) {
            for (var i = 0; i < solids.length; i++) {
              var e = solids[i];
              if ((e.kind === "plat" || e.kind === "crate") && x > e.x - 6 && x < e.x + e.w + 6) {
                if (prevY >= e.h - 1 && y <= e.h) { y = e.h; vy = 0; grounded = true; airJump = true; break; }
              }
            }
          }
          if (!grounded && y <= 0) {
            if (simGroundAt(solids, x)) { y = 0; vy = 0; grounded = true; airJump = true; }
            else if (y < -110) return false;
          }
        } else {
          var sup = (y <= 0 && simGroundAt(solids, x)) || simSupportTop(solids, x, y) >= 0;
          if (!sup) grounded = false;
        }
        if (grounded && x > gap.x + gap.w + 50) return true;
        if (x > gap.x + gap.w + 800) return false;
      }
      return false;
    }
    function canCrossGap(gap, solids, v) {
      var startX = gap.x - 1000;
      while (startX < gap.x - 120 && !simGroundAt(solids, startX)) startX += 12;
      var totalFrames = Math.floor((gap.x - startX) / (v * STEP));
      for (var ja = 0; ja <= totalFrames + 36; ja += 2) {
        if (simCrossGap(solids, gap, startX, v, ja, -1, -1)) return true;
        if (simCrossGap(solids, gap, startX, v, ja, ja + 9, -1)) return true;
        if (simCrossGap(solids, gap, startX, v, ja, ja, -1)) return true;
        if (simCrossGap(solids, gap, startX, v, ja, -1, ja + 16)) return true; // 2段ジャンプ (頂点前)
        if (simCrossGap(solids, gap, startX, v, ja, -1, ja + 24)) return true; // 2段ジャンプ (頂点後)
        if (simCrossGap(solids, gap, startX, v, ja, ja + 9, ja + 20)) return true; // ドロン+2段ジャンプ
        if (simCrossGap(solids, gap, startX, v, -1, -1, ja)) return true; // 走り落ちてから空中ジャンプ
      }
      return false;
    }
    function verifyChunkGaps(x0, x1) {
      var gaps = [];
      for (var i = 0; i < entities.length; i++) {
        var e = entities[i];
        if (e.kind === "gap" && e.x >= x0 && e.x < x1) gaps.push(e);
      }
      if (!gaps.length) return;
      var solids = simSolids(x0 - 1250, x1 + 420);
      for (var k = 0; k < gaps.length; k++) {
        var gap = gaps[k];
        var capG = speedCapAt(gap.x);
        var vEst = capG - 630 * Math.exp(-Math.max(0, gap.x) / 9000);
        if (vEst < SPEED_START) vEst = SPEED_START;
        var ok = canCrossGap(gap, solids, vEst) || canCrossGap(gap, solids, capG);
        while (!ok && gap.w > 130) {
          gap.w -= 30;
          ok = canCrossGap(gap, solids, vEst) || canCrossGap(gap, solids, capG);
        }
      }
    }

    /* ---------------- 落下岩の着地点検証 (第15次) ----------------
       通常の落下岩は前方で落ちて地上障害物として残るため (仕様変更)、
       着地点を生成時に通常の障害物と同じ基準で検証する:
       (1) 穴の上・直前 (手前110px以内) ・直後には置かない。
       (2) 他の障害物 (竹槍・岩・木箱・別の落下岩) と近すぎる位置には置かない。
       (3) 着地した岩を通常の岩として扱う走破シミュレーションで、チャンクを
           死なずに抜けられること (跳び越え可能性) を確認する。
       合格しない岩は横へずらして再検証し、それでも駄目なら置かない。
       フェイント岩 (トラップ) は verifyTrapChunk の管轄なので対象外。
       判定結果は FALL_AUDIT (window.__fallAudit) に全件残す */
    var FALL_AUDIT = [];
    var fallAuditCounts = { total: 0, ok: 0, moved: 0, removed: 0 };
    window.__fallAudit = FALL_AUDIT;
    function fallSpotClear(fx, self) {
      var cx = fx + 23;
      for (var i = 0; i < entities.length; i++) {
        var e = entities[i];
        if (e === self || e.dead) continue;
        if (e.kind === "gap") {
          if (cx > e.x - 110 && cx < e.x + e.w + 40) return false; // 穴の上・直前・直後
        } else if (e.kind === "spike" || e.kind === "rock" || e.kind === "crate" || e.kind === "fallrock" || e.kind === "feintrock") {
          if (Math.abs(e.x - fx) < 170) return false; // 他の障害物と重ねない
        } else if (e.kind === "plat") {
          if (fx + 46 > e.x - 30 && fx < e.x + e.w + 30) return false; // 足場の真下も避ける
        }
      }
      return true;
    }
    function verifyFallrocks(x0, x1) {
      var rocks = [];
      for (var i = 0; i < entities.length; i++) {
        var e0 = entities[i];
        if (e0.kind === "fallrock" && e0.x >= x0 && e0.x < x1) rocks.push(e0);
      }
      if (!rocks.length) return;
      for (var k = 0; k < rocks.length; k++) {
        var rk = rocks[k];
        var ox0 = rk.x, moved = false, ok = false;
        // 走破可能性: 着地した岩を通常の岩に見立てた solids で判定する
        var check = function () {
          if (!fallSpotClear(rk.x, rk)) return false;
          var solids = simSolids(x0 - 1250, x1 + 420).map(function (s) {
            return s === rk ? { kind: "rock", x: s.x, w: s.w, h: s.h } : s;
          });
          var capF = speedCapAt(rk.x);
          var vEst = capF - 630 * Math.exp(-Math.max(0, rk.x) / 9000);
          if (vEst < SPEED_START) vEst = SPEED_START;
          var startX = x0 - 160;
          while (startX < x0 + 40 && !simGroundAt(solids, startX)) startX += 12;
          return canTraverse(solids, null, startX, x1 + 60, vEst, false) || canTraverse(solids, null, startX, x1 + 60, capF, false);
        };
        ok = check();
        if (!ok) {
          var shifts = [180, -180, 340, -340];
          for (var si = 0; si < shifts.length && !ok; si++) {
            rk.x = ox0 + shifts[si];
            if (rk.x < x0 + 60 || rk.x > x1 - 140) continue;
            ok = check();
            if (ok) moved = true;
          }
        }
        fallAuditCounts.total++;
        if (ok) { fallAuditCounts.ok++; if (moved) fallAuditCounts.moved++; }
        else { rk.dead = true; fallAuditCounts.removed++; } // 検証を通らない落下岩は置かない
        FALL_AUDIT.push({ x: Math.round(rk.x), ok: ok, moved: moved, removed: !ok });
      }
    }

    /* ---------------- トラップチャンクの専用検証 (第9次) ----------------
       安全条件は2つとも生成時に同一物理シミュレーションで確認する:
       (1) 安全ルート: 罠アイテムを取らない通常攻略で、チャンク入口の手前から
           出口の先まで死なずに抜けられる軌道が存在すること。存在しない配置は
           採用せず、障害物・穴・岩を取り除いて平地化する (無効化)。
       (2) 罠アイテム: リスクのあるラインで取得でき、取得後に安全に着地できる
           こと (verifyOrb = 墨玉と同じ2段検証)。微調整しても成立しない
           罠アイテムは置かない (dead にする)。
       判定結果は TRAP_AUDIT (window.__trapAudit) に全件残す。 */
    var TRAP_AUDIT = [];
    var trapAuditCounts = { chunks: 0, safe: 0, safeJumpOnly: 0, rejected: 0, baitOk: 0, baitTotal: 0 };
    window.__trapAudit = TRAP_AUDIT;
    /* 走破シミュレーション: startX から速度 v で走り、jumpAt / dashAt /
       jump2At フレーム目に入力して endX まで死なずに到達できたら true。
       物理・致命判定は simTrajectory と同一 (竹槍/岩は致命、木箱/足場は着地、
       穴は落下死、角かすり補正あり)。フェイント落下岩は第24次で通常の
       落下岩に統一されたため、実ゲームと同じ fallPlan (速度 v のプラン) で
       モデル化する: 自機との距離が gap 以下で予告開始→prewarn＋warn→落下
       (重力 grav で 300px) →着地。落下点は固定配置のままで、着地の瞬間に
       真下にいる場合と、着地後に通常の岩として残り続ける障害物化を再現する */
    function simTraverse(solids, feint, startX, endX, v, jumpAt, dashAt, jump2At) {
      var dt = STEP;
      var x = startX, y = 0, vy = 0, grounded = true, dashT = 0, airJump = true;
      var fTrig = -1, fLandedAt = -1;
      for (var f = 0; f < 420; f++) {
        if (f === jumpAt && grounded) { vy = JUMP_VEL; grounded = false; }
        else if (f === jump2At && !grounded && airJump) { vy = JUMP_VEL * 0.95; airJump = false; }
        if (f === dashAt && dashT <= 0) { dashT = DASH_TIME; if (!grounded) vy = 0; }
        var cur = v * (dashT > 0 ? DASH_BOOST : 1);
        if (dashT > 0) dashT -= dt;
        x += cur * dt;
        if (!grounded) {
          var g = GRAV;
          if (Math.abs(vy) < 130) g *= 0.5; else if (vy < 0) g *= 1.18;
          if (dashT > 0) vy = 0; else vy -= g * dt;
          var prevY = y;
          y += vy * dt;
          if (vy <= 0) {
            for (var i = 0; i < solids.length; i++) {
              var e = solids[i];
              if ((e.kind === "plat" || e.kind === "crate") && x > e.x - 6 && x < e.x + e.w + 6) {
                if (prevY >= e.h - 1 && y <= e.h) { y = e.h; vy = 0; grounded = true; airJump = true; break; }
              }
            }
          }
          if (!grounded && y <= 0) {
            if (simGroundAt(solids, x)) { y = 0; vy = 0; grounded = true; airJump = true; }
            else if (y < -110) return false; // 穴に落下
          }
        } else {
          var sup = (y <= 0 && simGroundAt(solids, x)) || simSupportTop(solids, x, y) >= 0;
          if (!sup) grounded = false;
        }
        if (feint && fTrig < 0 && feint.x - x <= fallPlan(v).gap) fTrig = f;
        if (feint && fTrig >= 0 && fLandedAt < 0) {
          var ft = (f - fTrig) * dt;
          var fpl = fallPlan(v);
          var fFall = ft - fpl.pre - fpl.warn;
          if (fFall >= 0 && 0.5 * fpl.grav * fFall * fFall >= 300) {
            fLandedAt = f;
            if (grounded && Math.abs(feint.x + 23 - x) < 40 && dashT <= 0) return false; // 着地の瞬間に真下にいた
          }
        }
        var pL = x - 8, pR = x + 8, pB = y, pT = y + 24; // 実ゲームの当たり判定と一致 (第9次)
        for (var j = 0; j < solids.length; j++) {
          var o = solids[j];
          var feintLanded = feint && o === feint && fLandedAt >= 0; // 第24次: 着地後は通常の岩として残り続ける
          if (o.kind !== "spike" && o.kind !== "rock" && !feintLanded) continue;
          var oL = o.x + 6, oR = o.x + o.w - 6;
          var ox2 = Math.min(pR, oR) - Math.max(pL, oL);
          var oy2 = Math.min(pT, o.h) - Math.max(pB, 0);
          if (ox2 > 0 && oy2 > 0 && !(ox2 < 6 && oy2 < 6)) return false; // 致命障害物に接触
        }
        if (x > endX) return grounded || simGroundAt(solids, x);
      }
      return false;
    }
    function canTraverse(solids, feint, startX, endX, v, jumpOnly) {
      if (simTraverse(solids, feint, startX, endX, v, -1, -1, -1)) return true; // 走り抜け
      var totalFrames = Math.floor((endX - startX) / (v * STEP));
      for (var ja = 0; ja <= totalFrames; ja += 2) {
        if (simTraverse(solids, feint, startX, endX, v, ja, -1, -1)) return true;
        if (jumpOnly) continue;
        if (simTraverse(solids, feint, startX, endX, v, ja, ja + 9, -1)) return true;
        if (simTraverse(solids, feint, startX, endX, v, ja, -1, ja + 16)) return true;
        if (simTraverse(solids, feint, startX, endX, v, ja, -1, ja + 24)) return true;
        if (simTraverse(solids, feint, startX, endX, v, -1, -1, ja)) return true;
      }
      return false;
    }
    function verifyTrapChunk(x0, x1, ch) {
      var solids = simSolids(x0 - 1250, x1 + 420);
      var feint = null, bait = [];
      for (var i = 0; i < entities.length; i++) {
        var e = entities[i];
        if (e.x < x0 || e.x >= x1) continue;
        if (e.kind === "feintrock") feint = e;
        if (e.trap && e.kind === "orb") bait.push(e);
      }
      // (1) 安全ルート: 入口手前から出口の先まで抜けられること。
      // 開始位置は複数試す (墨玉検証と同じ考え方): チャンク入口は平地で揃う
      // 規約なので、入口付近から接地状態で入る軌道が1つでもあればよい
      var capT = speedCapAt(x0);
      var vEst = capT - 630 * Math.exp(-Math.max(0, x0) / 9000);
      if (vEst < SPEED_START) vEst = SPEED_START;
      var startOffs = [40, -160, -420, -1000];
      var safeJumpOnly = false, safe = false;
      for (var so = 0; so < startOffs.length && !safe; so++) {
        var startX = x0 + startOffs[so];
        while (startX < x0 + 40 && !simGroundAt(solids, startX)) startX += 12; // 開始点が穴の上なら手前の地面へ
        if (!canTraverse(solids, feint, startX, x1 + 60, vEst, true) && !canTraverse(solids, feint, startX, x1 + 60, capT, true)) {
          if (!canTraverse(solids, feint, startX, x1 + 60, vEst, false) && !canTraverse(solids, feint, startX, x1 + 60, capT, false)) continue;
        } else safeJumpOnly = true;
        safe = true;
      }
      var rejected = false;
      if (!safe) {
        // 安全ルートを保証できない配置は採用しない: 障害物・穴・岩を除いて平地化
        for (var r = entities.length - 1; r >= 0; r--) {
          var re = entities[r];
          if (re.x >= x0 && re.x < x1 && re.kind !== "orb") entities.splice(r, 1);
        }
        rejected = true;
      }
      // (2) 罠アイテム: リスクのあるラインで取得可能 (取得後の安全な着地まで)
      var baitOk = 0;
      for (var k = 0; k < bait.length; k++) {
        var it = bait[k];
        if (rejected) { it.dead = true; continue; }
        var res = verifyOrb(it, solids);
        var tries = 0;
        while (!res.ok && tries < 5) {
          // 罠玉ラインは上へ (槍から離す)、高台の宝は下へ (届く範囲へ) 微調整して再検証
          it.dy += (ch.trap === "takara" ? -12 : 10);
          if (ch.trap === "takara" && it.dy < 235) it.dy = 235;
          res = verifyOrb(it, solids);
          tries++;
        }
        if (res.ok) baitOk++;
        else it.dead = true; // どうしても取れない罠アイテムは置かない
      }
      trapAuditCounts.chunks++;
      if (rejected) trapAuditCounts.rejected++;
      else { trapAuditCounts.safe++; if (safeJumpOnly) trapAuditCounts.safeJumpOnly++; }
      trapAuditCounts.baitOk += baitOk;
      trapAuditCounts.baitTotal += bait.length;
      TRAP_AUDIT.push({ chunk: ch.name, type: ch.trap, safe: !rejected, safeJumpOnly: safeJumpOnly, rejected: rejected, baitOk: baitOk, baitTotal: bait.length });
    }

    /* ---------------- 巻物チャレンジ (第12次・ラン内ミッション) ----------------
       ラン開始時に1つ抽選 (シード付き rng で引くので同じシードでは同じ
       ミッションになる)。進捗は既存のラン内カウンタから導出する。
       目標値は「いいランなら届くが簡単すぎない」範囲でランダムに選ぶ */
    var MISSION_POOL = [
      { type: "orb", targets: [25, 35, 45, 60] },
      { type: "near", targets: [3, 4, 5, 6] },
      { type: "break", targets: [3, 4, 5] },
      { type: "dist", targets: [400, 550, 700, 900] },
      { type: "onigiri", targets: [1] }
    ];
    function pickMission() {
      var def = MISSION_POOL[(rng() * MISSION_POOL.length) | 0];
      var t = def.targets[(rng() * def.targets.length) | 0];
      return { type: def.type, target: t, done: false };
    }
    function missionProgress() {
      if (!mission) return 0;
      if (mission.type === "orb") return orbCount;
      if (mission.type === "near") return nearCount;
      if (mission.type === "break") return breakCount;
      if (mission.type === "dist") return Math.floor(scroll / PX_PER_M);
      if (mission.type === "onigiri") return onigiriCount;
      return 0;
    }
    function missionText(m) {
      if (m.type === "orb") return "墨玉を" + m.target + "個集めよ";
      if (m.type === "near") return "ニアミス" + m.target + "回決めよ";
      if (m.type === "break") return "障害物を" + m.target + "個壊せ";
      if (m.type === "dist") return m.target + "m走り抜けよ";
      if (m.type === "onigiri") return "おにぎりを取れ";
      return "";
    }
    function missionShort(m) {
      if (m.type === "orb") return "墨玉";
      if (m.type === "near") return "ニアミス";
      if (m.type === "break") return "破壊";
      if (m.type === "dist") return "距離";
      if (m.type === "onigiri") return "おにぎり";
      return "";
    }
    function missionUnit(m) {
      if (m.type === "orb" || m.type === "break") return "個";
      if (m.type === "near" || m.type === "onigiri") return "回";
      if (m.type === "dist") return "m";
      return "";
    }
    function showMissionBanner() {
      var b = document.getElementById("missionBanner");
      if (!b || !mission) return;
      document.getElementById("missionBannerText").textContent = missionText(mission);
      b.classList.add("show");
      if (missionBannerTimer) clearTimeout(missionBannerTimer);
      missionBannerTimer = setTimeout(function () { b.classList.remove("show"); }, 2000); // 開始直後に約2秒
    }
    function showBandBanner(name) {
      var b = document.getElementById("bandBanner");
      if (!b) return;
      b.textContent = "― " + name + " ―";
      b.classList.add("show");
      if (bandBannerTimer) clearTimeout(bandBannerTimer);
      bandBannerTimer = setTimeout(function () { b.classList.remove("show"); }, 1600);
    }
    function hideBanners() {
      var mb = document.getElementById("missionBanner"), bb = document.getElementById("bandBanner");
      if (mb) mb.classList.remove("show");
      if (bb) bb.classList.remove("show");
      if (missionBannerTimer) { clearTimeout(missionBannerTimer); missionBannerTimer = null; }
      if (bandBannerTimer) { clearTimeout(bandBannerTimer); bandBannerTimer = null; }
    }

    function reset(newSeed) {
      seed = newSeed >>> 0;
      rng = mulberry32(seed);
      scroll = 0; prevScroll = 0; speed = SPEED_START; elapsed = 0; runTime = 0;
      player = {
        y: 0, prevY: 0, vy: 0, grounded: true, coyote: 0, bufferAt: -9, airJump: true,
        holding: false, dashT: 0, dashCd: 0, dashOff: 0, squash: 0, squashV: 0, runPhase: 0,
        dead: false, deadY: 0
      };
      katonProjectiles = [];
      parts = []; entities = []; chunkZones = [];
      nextChunkAt = 500; chunkCount = 0; recentChunks = []; bags = [[], [], []];
      lastTrapChunk = -99; lastTrapType = -1; deathTrap = false;
      pitTimer = 0; pitAlpha = 1; pitY0 = 0; pitScrollV = 0;
      bags[0] = newBag(0); bags[1] = newBag(1); bags[2] = newBag(2);
      score = 0; nearCount = 0; mult = 1; maxMult = 1; combo = 0;
      orbCount = 0; breakCount = 0; dashUseCount = 0; throwCount = 0;
      onigiriCount = 0; invincibleT = 0; oniTimer.since = 0; oniTimer.tries = 0; oniTimer.placed = 0; // 出現抽選はランごとにリセット (第17次)。序盤ガードは firstAt が担う
      mission = pickMission(); fullBlackDone = false; // 巻物はラン開始時に1つ抽選 (第12次)
      bunshinStock = 0; bunshinSaveCount = 0; bunTimer.since = 0; bunTimer.tries = 0; bunTimer.placed = 0; // 出現抽選リセット (第17次)
      kawarimiFx = null; kawarimiT = 0;
      katonBalls = 0; katonCd = 0; katonKillCount = 0; enemyKillCount = 0; katTimer.since = 0; katTimer.tries = 0; katTimer.placed = 0; // 出現抽選リセット (第17次)
      katonPickupCount = 0; // 3遁称号用 (第25次)
      suitonEndX = 0; suitonUses = 0; waveKillCount = 0; waveGapCount = 0; suiTimer.since = 0; suiTimer.tries = 0; suiTimer.placed = 0; // 水遁リセット (第25次)
      fuutonUses = 0; fuutonKillCount = 0; fuutonMaxChain = 0; tornadoes = []; fuuTimer.since = 0; fuuTimer.tries = 0; fuuTimer.placed = 0; // 風遁リセット (第25次)
      enemyTimer = 5;
      patternMode = ""; patternLeft = 0; // パターンモードはランごとに引き直す (第14次)
      nextBreatherAt = 6 + ((rng() * 4) | 0); // 休息の間隔もランごとに引き直す (第18次・対策3)
      CHUNK_AUDIT.length = 0; // 選出系列の計測はラン単位 (第18次・対策5)
      bubbleT = 0; bubbleCd = 0; lastBandIdx = 0;
      trauma = 0; hitstop = 0; timeScale = 1; slowTimer = 0;
      camY = 0; prevCamY = 0; popups = [];
      deathReason = "";
      ghostTrail = [];
      while (nextChunkAt < W + 900) spawnChunk();
    }

    /* ---------------- パーティクル (プール) ---------------- */
    var PART_MAX = 320;
    function addPart(kind, x, y, vx, vy, life, size, col) {
      if (parts.length >= PART_MAX) return; // 枯渇時は作らない (Nystrom)
      parts.push({ kind: kind, x: x, y: y, vx: vx, vy: vy, life: life, maxLife: life, size: size, col: col, seed: Math.random() * 10 });
    }
    function dust(x, y, n, spread) {
      for (var i = 0; i < n; i++)
        addPart("dot", x + (Math.random() - 0.5) * 14, y - Math.random() * 4,
          -(40 + Math.random() * 90) * (spread || 1), -20 - Math.random() * 50,
          0.35 + Math.random() * 0.3, 2 + Math.random() * 3.5, "ink");
    }
    function inkBurst(x, y, n) {
      for (var i = 0; i < n; i++) {
        var a = Math.random() * Math.PI * 2, v = 60 + Math.random() * 190;
        addPart("dot", x, y, Math.cos(a) * v, Math.sin(a) * v - 60, 0.4 + Math.random() * 0.35, 2 + Math.random() * 3, "ink");
      }
    }
    function inkRing(x, y) {
      // 2段ジャンプ発動: 足元に小さな墨の輪が広がり、しぶきが散る
      addPart("ring", x, y - 6, 0, 0, 0.32, 6, "ink");
      for (var i = 0; i < 6; i++)
        addPart("dot", x + (Math.random() - 0.5) * 22, y - 4,
          (Math.random() - 0.5) * 130, -30 - Math.random() * 70,
          0.3 + Math.random() * 0.2, 1.8 + Math.random() * 2.2, "ink");
    }
    function smoke(x, y) {
      for (var i = 0; i < 14; i++)
        addPart("smoke", x + (Math.random() - 0.5) * 26, y - Math.random() * 36,
          -30 - Math.random() * 60, -14 - Math.random() * 30, 0.5 + Math.random() * 0.4, 9 + Math.random() * 13, "smoke");
    }
    function shards(x, y) {
      for (var i = 0; i < 12; i++)
        addPart("shard", x, y, (Math.random() - 0.3) * 260, -120 - Math.random() * 220, 0.55 + Math.random() * 0.3, 4 + Math.random() * 6, "wood");
    }

    /* ---------------- 入力 ---------------- */
    var stageEl = document.getElementById("stage");
    function pressJump() {
      AudioSys.init();
      if (state === "playing") player.bufferAt = elapsed;
      player.holding = true;
      btnJump.classList.add("on");
    }
    function releaseJump() {
      player.holding = false;
      btnJump.classList.remove("on");
      if (state === "playing" && !player.grounded && player.vy < -300) player.vy = -300; // 可変ジャンプ
    }
    function pressDash() {
      AudioSys.init();
      if (state !== "playing") return;
      if (player.dashCd <= 0 && player.dashT <= 0) {
        player.dashT = DASH_TIME;
        player.dashCd = DASH_CD;
        dashUseCount++; // プレイ計測 (P0)
        if (!player.grounded) player.vy = 0;
        smoke(PLAYER_X - scroll * 0 + playerScreenX() - 10, GROUND_Y - player.y - 30);
        AudioSys.dash();
        addTrauma(0.12);
      }
    }
    function playerScreenX() { return PLAYER_X + player.dashOff; }

    /* プレイ操作は各ボタンのポインタイベントでのみ受け付ける。
       ボタンごとにポインタをキャプチャするので、長押し中の指がボタンから
       少しずれても、そのボタンの pointerup / pointercancel で確実に
       離し判定になる。ジャンプを押しながら別の指でドロン／攻撃する
       マルチタッチも、ボタン単位で独立に働く */
    function capturePointer(el, e) {
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
    }
    var btnJump = document.getElementById("btnJump");
    var btnDash = document.getElementById("btnDash");
    var jumpPointerId = null; // ジャンプを押しているポインタ (離し判定の対応付け用)
    btnJump.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      jumpPointerId = e.pointerId;
      capturePointer(btnJump, e);
      pressJump();
    });
    btnJump.addEventListener("pointerup", function (e) {
      e.preventDefault();
      if (jumpPointerId === e.pointerId || jumpPointerId === null) { jumpPointerId = null; releaseJump(); }
    });
    btnJump.addEventListener("pointercancel", function (e) {
      if (jumpPointerId === e.pointerId || jumpPointerId === null) { jumpPointerId = null; releaseJump(); }
    });
    btnJump.addEventListener("lostpointercapture", function () {
      // pointerup 済みなら jumpPointerId は null なので二重に離し判定しない
      if (jumpPointerId !== null) { jumpPointerId = null; releaseJump(); }
    });
    btnDash.addEventListener("pointerdown", function (e) { e.preventDefault(); capturePointer(btnDash, e); pressDash(); btnDash.classList.add("on"); });
    btnDash.addEventListener("pointerup", function () { btnDash.classList.remove("on"); });
    btnDash.addEventListener("pointercancel", function () { btnDash.classList.remove("on"); });
    btnDash.addEventListener("lostpointercapture", function () { btnDash.classList.remove("on"); });
    /* 入力はボタンのみ: Canvas／ステージのボタン以外の場所への
       タップ・クリックにはゲーム操作のハンドラを付けない
       (旧仕様の「画面タップ＝ジャンプ」は廃止)。
       回転表示モードでも、DOMボタンのヒットテストはブラウザが
       transform に追随させるため、ボタン判定はそのまま正しく働き、
       入力のための座標変換は不要 */
    var rotatedView = false;
    window.addEventListener("keydown", function (e) {
      if (e.repeat) return;
      if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyJ") {
        if (state === "title" || state === "over") return;
        e.preventDefault(); pressJump();
      } else if (e.code === "ShiftLeft" || e.code === "ShiftRight" || e.code === "KeyK") {
        e.preventDefault(); pressDash();
      } else if (e.code === "KeyP" || e.code === "Escape") {
        togglePause();
      } else if (e.code === "Enter") {
        if (state === "title") startRun((Math.random() * 900000 + 10000) | 0);
        else if (state === "over") startRun((Math.random() * 900000 + 10000) | 0);
      }
    });
    window.addEventListener("keyup", function (e) {
      if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyJ") releaseJump();
    });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden && state === "playing") setPause(true);
    });

    /* ---------------- 物理ステップ (60Hz固定) ---------------- */
    function addTrauma(v) { trauma = clamp(trauma + v, 0, 1); }
    function addPopup(x, y, text, col) {
      popups.push({ x: x, y: y, text: text, col: col, life: 0.85 });
    }
    function addScore(base, x, y) {
      var gain = Math.round(base * mult);
      score += gain;
      return gain;
    }
    function bumpCombo() {
      combo++;
      if (combo % 5 === 0 && mult < 8) {
        mult = Math.min(8, mult + 0.5);
        if (mult > maxMult) maxMult = mult;
      }
    }

    function groundAt(worldX) {
      // 穴の上かどうか
      for (var i = 0; i < entities.length; i++) {
        var e = entities[i];
        if (e.kind === "gap" && worldX > e.x + 6 && worldX < e.x + e.w - 6) return false;
      }
      return true;
    }
    function platformTop(worldX, feetY) {
      // ワンウェイ足場: 足が上面付近にあればその高さを返す (なければ -1)
      var best = -1;
      for (var i = 0; i < entities.length; i++) {
        var e = entities[i];
        if (e.kind !== "plat" && !(e.kind === "crate" && !e.dead)) continue;
        var top = e.kind === "plat" ? e.h : e.h; // 地面からの高さ
        if (worldX > e.x - 4 && worldX < e.x + e.w + 4) {
          if (Math.abs(feetY - top) < 14 && top > best) best = top;
        }
      }
      return best;
    }

    function die(reason) {
      if (state !== "playing") return;
      /* 変わり身の術 (第12次・第14次で改称と演出変更): 障害物への致命的接触は、
         ストックがあれば術が肩代わりし、約1秒の無敵を得てラン継続する。
         発動の瞬間は、当たった場所に丸太がポンッと残って煙に消え、本体が
         ちらつきながら現れる定番の見せ方にする (第14次・仕様B)。
         落とし穴は die() を通らない (startPitFall) ので対象外のまま */
      if (bunshinStock > 0) {
        bunshinStock--;
        bunshinSaveCount++;
        invincibleT = Math.max(invincibleT, 1.0);
        hitstop = Math.max(hitstop, 4 / 60);
        addTrauma(0.35);
        kawarimiFx = { wx: scroll + playerScreenX(), y: player.y, t: 0.85 }; // 丸太はワールドに置いて流れていく
        kawarimiT = 0.45; // 本体は短くちらついて「現れた」感を出す
        smoke(playerScreenX(), GROUND_Y - player.y - 6);
        inkBurst(playerScreenX(), GROUND_Y - player.y - 34, 16);
        inkRing(playerScreenX(), GROUND_Y - player.y - 10);
        addPopup(playerScreenX() - 40, GROUND_Y - player.y - 76, "変わり身の術！", "#dfe6f5");
        AudioSys.bunshinSave();
        updateHud();
        return;
      }
      state = "dying";
      deathReason = reason;
      // トラップチャンク内での死亡か (結果画面のコメントを「欲をかいた。」に差し替える)
      var dpx = scroll + playerScreenX();
      deathTrap = false;
      for (var zi = 0; zi < chunkZones.length; zi++) {
        if (chunkZones[zi].trap && dpx >= chunkZones[zi].x0 && dpx < chunkZones[zi].x1) { deathTrap = true; break; }
      }
      player.dead = true;
      addTrauma(0.9);
      hitstop = 12 / 60;
      slowTimer = 0.85; timeScale = 0.28;
      inkBurst(playerScreenX(), GROUND_Y - player.y - 30, 22);
      AudioSys.die();
    }

    /* 落とし穴の死亡演出 (第11次): 即終了にせず、キャラが穴へ沈み続けながら
       フェードアウトし、完全に消えた時点で死亡確定 → 結果画面。
       入力は state が playing でなくなることで無効になる。死因と
       トラップ判定 (コメント「欲をかいた。」) は die() と同じ規則で決める */
    function startPitFall() {
      if (state !== "playing") return;
      state = "pitfall";
      deathReason = "落とし穴に落ちた";
      var dpx = scroll + playerScreenX();
      deathTrap = false;
      for (var zi = 0; zi < chunkZones.length; zi++) {
        if (chunkZones[zi].trap && dpx >= chunkZones[zi].x0 && dpx < chunkZones[zi].x1) { deathTrap = true; break; }
      }
      player.dead = true;
      pitTimer = 0;
      pitAlpha = 1;
      pitY0 = player.y;
      pitScrollV = speed;
      AudioSys.die();
    }
    /* 波の押し流し (第25次・水遁): 波乗り中に触れた地上障害物を消去する。
       扱いは火遁の排除と同じ (+100点・倍率寄与・破壊数カウント)。
       敵忍者は呼び出し側 (敵ブロック) で撃破として処理する */
    function waveDestroy(e, sx) {
      e.dead = true;
      waveKillCount++;
      breakCount++;
      if (e.kind === "crate") shards(sx + 23, GROUND_Y - 24);
      for (var wf = 0; wf < 7; wf++)
        addPart("foam", sx + e.w / 2, GROUND_Y - 8 - Math.random() * 22, (Math.random() - 0.5) * 190, -70 - Math.random() * 130, 0.35 + Math.random() * 0.25, 2.4 + Math.random() * 3, "foam");
      var wg = addScore(100, sx, GROUND_Y - e.h - 14);
      addPopup(sx + 2, GROUND_Y - e.h - 30, "波 +" + wg, "#8ecdf2");
      bumpCombo();
      AudioSys.suitonHit();
    }
    /* 波の終了可否 (第25次): 終了地点で自機が穴の上にいないこと、かつ
       すぐ前方 (約190px) に回避不能な障害物がないこと。安全でなければ
       波は1mずつ延長され、安全な場所でだけ終わる */
    function waveEndSafe(px) {
      if (!groundAt(px)) return false;
      for (var i = 0; i < entities.length; i++) {
        var e = entities[i];
        if (e.dead) continue;
        var isOb = e.kind === "spike" || e.kind === "rock" || e.kind === "crate" || e.kind === "enemy" ||
                   ((e.kind === "fallrock" || e.kind === "feintrock") && e.state === "landed");
        if (!isOb) continue;
        if (e.x + e.w > px - 12 && e.x < px + 190) return false;
      }
      return true;
    }
    /* 火遁の照準点 (第14次): 対象の中心を [ワールドx, 地面からの高さ] で返す。
       落下岩は状態で高さが変わる (落下中は空中の位置を追い続ける) */
    function katonTargetPoint(te) {
      if (te.kind === "fallrock" || te.kind === "feintrock") {
        if (te.state === "fall" || te.state === "fallpit") return [te.x + 23, 330 - te.dy - 22];
        if (te.state === "warn" || te.state === "prewarn") return [te.x + 23, 308];
        return [te.x + 23, 22];
      }
      if (te.kind === "enemy") return [te.x + te.w / 2, te.y + te.h / 2];
      return [te.x + te.w / 2, te.h / 2];
    }
    /* 敵忍者の出現 (第14次・仕様F): 回避不能を作らないための出現条件。
       出現位置は画面右端の少し外。プレイヤー前方の遭遇想定区間に、落とし穴・
       他の障害物・警告中の落下岩・別の敵が重なる場合は出さない */
    function trySpawnEnemy(px) {
      var spawnX = scroll + W + 70;
      for (var i = 0; i < entities.length; i++) {
        var e = entities[i];
        if (e.dead) continue;
        if (e.kind === "enemy" && Math.abs(e.x - spawnX) < 560) return false; // 敵同士は間隔を空ける
        if (e.kind === "gap" && e.x + e.w > px - 40 && e.x < spawnX + 60) return false; // 穴の上・直前・渡り切り直後には出さない
        if ((e.kind === "spike" || e.kind === "rock" || e.kind === "crate") && e.x > px + 120 && e.x < px + 700) return false; // 遭遇地点に他の障害物を重ねない
        if ((e.kind === "fallrock" || e.kind === "feintrock") && e.state !== "idle" && e.state !== "landed") return false; // 落下イベント中は重ねない
      }
      if (!groundAt(spawnX + 30)) return false;
      // 当たり判定 (第15次で拡大): 見た目 (約110px) より一回り小さい甘め判定。
      // w60×h68 でもジャンプ回避窓は速度960で33フレーム／全体上限1120でも
      // 33フレーム確保できることを数値シミュレーションで確認済み (第21次)
      entities.push({ kind: "enemy", x: spawnX, w: 60, h: 68, dy: 0, y: 0, vy: 0, grounded: true, runPh: Math.random() * 6,
                      trap: false, state: "run", timer: 0, passed: false, nearDone: false, dead: false });
      return true;
    }
    window.__trySpawnEnemy = trySpawnEnemy;

    function stepPit(dt) {
      elapsed += dt;
      prevScroll = scroll;
      player.prevY = player.y;
      prevCamY = camY;
      pitTimer += dt;
      var p = clamp(pitTimer / PIT_DUR, 0, 1);
      // 沈下は ease-in で加速しながら約165px。フェードはほぼ線形に 1→0
      player.y = pitY0 - 165 * Math.pow(p, 1.35);
      pitAlpha = clamp(Math.pow(1 - p, 1.1), 0, 1);
      // ワールドは自然に減速する
      scroll += pitScrollV * dt;
      pitScrollV *= Math.exp(-2.4 * dt);
      player.dashOff = lerp(player.dashOff, 0, 0.12);
      if (player.dashT > 0) player.dashT -= dt;
      for (var gt = ghostTrail.length - 1; gt >= 0; gt--) {
        ghostTrail[gt].life -= dt;
        if (ghostTrail[gt].life <= 0) ghostTrail.splice(gt, 1);
      }
      for (var q = parts.length - 1; q >= 0; q--) {
        var pt = parts[q];
        pt.life -= dt;
        if (pt.life <= 0) { parts.splice(q, 1); continue; }
        pt.x += pt.vx * dt - pitScrollV * dt * 0.55;
        pt.y += pt.vy * dt;
        if (pt.kind === "dot") pt.vy += 300 * dt;
      }
      trauma = Math.max(0, trauma - 1.4 * dt);
      shakeT += dt;
      if (pitTimer >= PIT_DUR) showGameOver();
    }

    function step(dt) {
      elapsed += dt;
      runTime += dt;
      prevScroll = scroll;
      player.prevY = player.y;
      prevCamY = camY;

      // 速度: 序盤速く・終盤緩やかな対数型に近い漸増 (レポートの設計提案)。
      // 上限は周回ごとに微増する (第14次・仕様E: speedCapAt)。
      // 第21次: 上限だけを引き上げ、漸増の係数 (不足分への比例項+線形項) は
      // 従来どおりとした — 不足分に対する接近比率 (時定数) が不変なので、
      // 上限が上がっても加速の体感が急にはならない
      var target = speedCapAt(scroll);
      speed += (target - speed) * 0.011 * dt * 60 * 0.16 + 2.4 * dt;
      if (speed > target) speed = target;

      var dashing = player.dashT > 0;
      if (player.dashT > 0) player.dashT -= dt;
      if (player.dashCd > 0) player.dashCd -= dt;
      if (invincibleT > 0) invincibleT = Math.max(0, invincibleT - dt); // おにぎり無敵の残り時間
      if (kawarimiT > 0) kawarimiT -= dt; // 変わり身: 本体のちらつき (第14次)
      if (kawarimiFx) { kawarimiFx.t -= dt; if (kawarimiFx.t <= 0) kawarimiFx = null; } // 変わり身の丸太 (第14次)
      if (bubbleT > 0) bubbleT -= dt; // ニアミス吹き出し (第12次)
      if (bubbleCd > 0) bubbleCd -= dt;
      // 距離帯の切り替わり検出 (第12次・周回対応 第14次): 新しい帯に入ったら
      // 帯名を小さく出す (2周目以降は「竹林 2周目」のように周回も示す)
      var bandKeyNow = lapAt(scroll / PX_PER_M) * 4 + bandIndex(scroll / PX_PER_M);
      if (bandKeyNow !== lastBandIdx) { lastBandIdx = bandKeyNow; showBandBanner(bandName(scroll / PX_PER_M)); }
      var curSpeed = speed * (dashing ? DASH_BOOST : 1);
      scroll += curSpeed * dt;
      player.dashOff = lerp(player.dashOff, dashing ? 52 : 0, dashing ? 0.55 : 0.10);
      player.runPhase += curSpeed * dt * 0.055;

      // ドロン残像: 記録して寿命で消す
      for (var gt = ghostTrail.length - 1; gt >= 0; gt--) {
        ghostTrail[gt].life -= dt;
        if (ghostTrail[gt].life <= 0) ghostTrail.splice(gt, 1);
      }
      if (dashing && ghostTrail.length < 16) {
        ghostTrail.push({ scroll: scroll, y: player.y, off: player.dashOff,
          life: 0.24, maxLife: 0.24, ph: player.runPhase,
          lean: 0.46 });
        // ダッシュ中の墨しぶき
        if (Math.random() < 0.7)
          addPart("dot", playerScreenX() - 24, GROUND_Y - player.y - 20 - Math.random() * 40,
            -120 - Math.random() * 120, (Math.random() - 0.5) * 60, 0.3 + Math.random() * 0.2, 2 + Math.random() * 2.5, "ink");
      }
      // 走行中は足元から墨が飛ぶ
      if (player.grounded && Math.random() < 0.30)
        addPart("dot", playerScreenX() - 12, GROUND_Y - player.y - 3,
          -50 - Math.random() * 90, -70 - Math.random() * 130, 0.32 + Math.random() * 0.2, 1.8 + Math.random() * 2, "ink");

      var px = scroll + playerScreenX(); // プレイヤーのワールドx (当たり判定中心)
      var wasGrounded = player.grounded;

      /* 水遁の波 (第25次): 50m進んだら終わるが、終了地点の先が安全でない
         間は1mずつ延長し、安全な場所でだけ終わる (終了直後の即死防止)。
         波乗り中は足元に泡を出し続ける */
      if (suitonEndX > 0) {
        if (scroll >= suitonEndX) {
          if (waveEndSafe(px)) {
            suitonEndX = 0;
            for (var we = 0; we < 10; we++)
              addPart("foam", playerScreenX() + (Math.random() - 0.5) * 60, GROUND_Y - player.y - 4, (Math.random() - 0.5) * 160, -60 - Math.random() * 110, 0.4 + Math.random() * 0.3, 2.4 + Math.random() * 3, "foam");
          } else suitonEndX = scroll + PX_PER_M; // 安全になるまで1m延長
        }
        if (suitonOn() && Math.random() < 0.75)
          addPart("foam", playerScreenX() - 26 + Math.random() * 30, GROUND_Y - 3, -60 - Math.random() * 90, -40 - Math.random() * 80, 0.3 + Math.random() * 0.25, 2 + Math.random() * 3, "foam");
      }

      // --- ジャンプ (バッファ + コヨーテ) ---
      if (elapsed - player.bufferAt <= BUFFER) {
        if (player.grounded || player.coyote > 0) {
          player.vy = JUMP_VEL;
          player.grounded = false;
          player.coyote = 0;
          player.bufferAt = -9;
          player.squashV = -8; // 伸び方向へバネの初速 (スカッシュはバネで減衰)
          dust(playerScreenX(), GROUND_Y - player.y, 5, 1);
          AudioSys.jump();
        } else if (player.airJump) {
          // 2段ジャンプ: 上昇中でも落下中でも発動し、落下速度をリセットして
          // 再上昇する (ジャンプ力は1段目の95%)。足場から走り落ちた場合も、
          // 1段目を使っていなければ空中ジャンプを1回使える。バッファは
          // 1段目と同じく適用される。ドロンの回数管理とは独立で、着地でリセット
          player.vy = JUMP_VEL * 0.95;
          player.airJump = false;
          player.bufferAt = -9;
          player.squashV = -8;
          inkRing(playerScreenX(), GROUND_Y - player.y);
          AudioSys.jump2();
        }
      }
      // --- 重力 (頂点付近で 1/2: Thorson) ---
      var g = GRAV;
      if (!player.grounded) {
        if (Math.abs(player.vy) < 130 && player.holding) g *= 0.5;
        else if (player.vy < 0) g *= 1.18; // 落下は少し速く
      }
      if (dashing && !player.grounded) player.vy = 0;
      else player.vy -= g * dt;
      if (player.vy < -1500) player.vy = -1500;
      player.y += player.vy * dt;

      // --- 着地判定 ---
      var onGroundLine = groundAt(px) || suitonOn(); // 波乗り中は波が穴の上を渡る (第25次): 穴に落ちない
      var platTop = -1;
      if (player.vy <= 0) platTop = platformTop(px, player.y + Math.min(0, player.vy * dt) - player.vy * dt + player.y - player.y + (player.y));
      // 足場: 落下中に上面を跨いだら着地
      var landed = false;
      if (player.vy <= 0) {
        for (var i = 0; i < entities.length; i++) {
          var e = entities[i];
          if ((e.kind === "plat" || (e.kind === "crate" && !e.dead)) && px > e.x - 6 && px < e.x + e.w + 6) {
            var topY = e.h;
            if (player.prevY >= topY - 1 && player.y <= topY) {
              player.y = topY; player.vy = 0; landed = true; break;
            }
          }
        }
      }
      if (!landed) {
        if (player.y <= 0) {
          if (onGroundLine) {
            player.y = 0;
            if (!wasGrounded && player.vy < -500) { addTrauma(0.10); dust(playerScreenX(), GROUND_Y, 7, 1.2); inkBurst(playerScreenX(), GROUND_Y - 4, 6); AudioSys.land(); }
            else if (!wasGrounded) AudioSys.land();
            player.vy = 0;
            landed = true;
          } else {
            // 落とし穴に落下中: 死亡条件 (y<-110) は検証シミュレーションと
            // 一致させたまま、即終了せずフェードアウト演出へ移る (第11次)
            if (player.y < -110) { startPitFall(); player.deadY = player.y; }
          }
        }
      }
      player.grounded = landed;
      if (landed) { player.coyote = COYOTE; player.airJump = true; if (!wasGrounded) player.squashV = 8.5; } // 着地: コヨーテと2段ジャンプをリセット。バネに初速を与えて潰れる
      else if (wasGrounded) player.coyote = COYOTE;
      else if (player.coyote > 0) player.coyote -= dt;
      // スカッシュはバネ-ダンパーで減衰 (瞬時リセットせず、行き過ぎて戻る)
      player.squashV += (-190 * player.squash - 13.5 * player.squashV) * dt;
      player.squash += player.squashV * dt;

      // 走行中の土煙
      if (player.grounded && (scroll % 26) < curSpeed * dt) dust(playerScreenX() - 16, GROUND_Y - player.y, 1, 0.7);

      // --- エンティティ更新 ---
      var pLeft = px - 8, pRight = px + 8;
      var pBot = player.y, pTop = player.y + 24; // 寛容な当たり判定 (見た目より小さい)。キャラ縮小に比例して縮小 (第4次 本体189→160: 幅30→26・高さ46→39 / 第8次 本体160→136: 幅26→22・高さ39→33 / 第9次 本体136→100: 幅22→16・高さ33→24)
      for (var j = entities.length - 1; j >= 0; j--) {
        var en = entities[j];
        var sx = en.x - scroll;
        if (sx + Math.max(en.w, 30) < -80) { entities.splice(j, 1); continue; }
        if (en.kind === "orb") {
          if (!en.dead && Math.abs(en.x + 10 - px) < 34 && Math.abs((en.dy + player.y * 0) - 0) >= 0) {
            var orbY = en.dy; // 地面からの高さ
            var py = player.y + 18; // 取得中心はキャラ縮小に比例 (第9次: +24→+18)。検証シミュレーションと一致
            if (Math.abs(en.x + 10 - px) < 34 && Math.abs(orbY - py) < 40) {
              en.dead = true;
              orbCount++; // 墨の濃さ (第11次): 濃さ・オーラはこのラン内カウンタから毎フレーム導出する (保存なし)
              var og = addScore(50, sx, GROUND_Y - orbY);
              bumpCombo();
              inkBurst(sx + 10, GROUND_Y - orbY, 5);
              AudioSys.orb();
              /* 真っ黒到達のご褒美 (第12次): 200個に届いた瞬間に1回だけ。
                 墨が弾けるパーティクル＋ポップアップ＋専用SE＋ボーナス+200 */
              if (orbCount >= 200 && !fullBlackDone) {
                fullBlackDone = true;
                score += 200;
                inkBurst(playerScreenX(), GROUND_Y - player.y - 46, 30);
                inkBurst(playerScreenX(), GROUND_Y - player.y - 20, 16);
                inkRing(playerScreenX(), GROUND_Y - player.y - 8);
                addPopup(playerScreenX() - 26, GROUND_Y - player.y - 84, "真っ黒！ +200", "#ffd97a");
                addTrauma(0.18);
                AudioSys.fullBlack();
              }
            }
          }
          continue;
        }
        if (en.kind === "onigiri") {
          if (!en.dead && Math.abs(en.x + 20 - px) < 44 && Math.abs(en.dy - (player.y + 18)) < 50) { // 取得範囲は拡大に合わせて少し広げる (第14次・仕様A)
            en.dead = true;
            onigiriCount++;
            invincibleT = 5; // 5秒間無敵 (落とし穴は対象外)
            addPopup(sx + 2, GROUND_Y - en.dy - 32, "おにぎり！ 無敵5秒", "#e8b64c");
            inkBurst(sx + 15, GROUND_Y - en.dy, 6);
            AudioSys.onigiri();
          }
          continue;
        }
        if (en.kind === "bunshin") {
          if (!en.dead && Math.abs(en.x + 20 - px) < 44 && Math.abs(en.dy - (player.y + 18)) < 50) { // 取得範囲は拡大に合わせて少し広げる (第14次・仕様A)
            en.dead = true;
            if (bunshinStock < 1) {
              bunshinStock = 1; // ストックは最大1体 (第12次)
              addPopup(sx - 10, GROUND_Y - en.dy - 36, "変わり身の術！ 身代わり1体", "#dfe6f5");
            } else {
              var bg2 = addScore(100, sx, GROUND_Y - en.dy); // 満タンの時は得点に替える
              addPopup(sx - 2, GROUND_Y - en.dy - 36, "変わり身 +" + bg2, "#dfe6f5");
            }
            inkBurst(sx + 20, GROUND_Y - en.dy, 6);
            AudioSys.bunshinGet();
            updateHud();
          }
          continue;
        }
        if (en.kind === "katon") {
          if (!en.dead && Math.abs(en.x + 20 - px) < 44 && Math.abs(en.dy - (player.y + 18)) < 50) {
            en.dead = true;
            katonPickupCount++; // 3遁称号用 (第25次)
            katonBalls = 5; // 火の玉は5個にリフレッシュ (5を超えて貯まらない・第14次)
            addPopup(sx - 8, GROUND_Y - en.dy - 36, "火遁！ 火の玉×5", "#ff9d5c");
            for (var kf = 0; kf < 8; kf++)
              addPart("fire", sx + 20, GROUND_Y - en.dy, (Math.random() - 0.5) * 160, -60 - Math.random() * 120, 0.4 + Math.random() * 0.3, 3 + Math.random() * 3.5, "fire");
            AudioSys.katonGet();
          }
          continue;
        }
        if (en.kind === "suiton") {
          if (!en.dead && Math.abs(en.x + 20 - px) < 44 && Math.abs(en.dy - (player.y + 18)) < 50) {
            en.dead = true;
            suitonUses++;
            suitonEndX = scroll + WAVE_M * PX_PER_M; // 50m先まで波乗り (波乗り中の取り直しは残りを50mに張り直す)
            addPopup(sx - 8, GROUND_Y - en.dy - 36, "水遁！ 波乗り50m", "#8ecdf2");
            for (var sf = 0; sf < 12; sf++)
              addPart("foam", sx + 20, GROUND_Y - en.dy, (Math.random() - 0.5) * 200, -50 - Math.random() * 130, 0.4 + Math.random() * 0.3, 2.4 + Math.random() * 3.2, "foam");
            AudioSys.suitonGet();
            updateHud();
          }
          continue;
        }
        if (en.kind === "fuuton") {
          if (!en.dead && Math.abs(en.x + 20 - px) < 44 && Math.abs(en.dy - (player.y + 18)) < 50) {
            en.dead = true;
            fuutonUses++;
            tornadoes.push({ x: px + 90, spawnX: px + 90, kills: 0 }); // 竜巻は取得した瞬間に前方へ1発 (第25次)
            addPopup(sx - 8, GROUND_Y - en.dy - 36, "風遁！ 竜巻", "#a8e6c8");
            for (var ff = 0; ff < 8; ff++)
              addPart("foam", sx + 20, GROUND_Y - en.dy, 60 + Math.random() * 160, -40 - Math.random() * 100, 0.35 + Math.random() * 0.25, 2 + Math.random() * 3, "foam");
            AudioSys.fuutonCast();
          }
          continue;
        }
        if (en.kind === "enemy") {
          // 敵忍者 (第14次・仕様F): 地面を自機へ向かって走る。穴に差しかかったら
          // 小さく跳んで渡り、落ちたら消える (回避不能を作らないための挙動)
          en.runPh = (en.runPh || 0) + dt * 11;
          en.x -= ENEMY_RUN * dt;
          if (en.grounded) {
            if (!groundAt(en.x - 14)) { en.vy = 640; en.grounded = false; } // 穴の手前で跳ぶ
          }
          if (!en.grounded) {
            en.vy -= GRAV * 0.92 * dt;
            en.y += en.vy * dt;
            if (en.y <= 0) {
              if (groundAt(en.x)) { en.y = 0; en.vy = 0; en.grounded = true; }
              else if (en.y < -120) { en.dead = true; continue; }
            }
          }
          if (en.dead) continue;
          // 接触判定 (障害物と同格): 無敵中はすり抜け、変わり身の対象になる
          var eL = en.x + 4, eR = en.x + en.w - 4;
          var eovX = Math.min(pRight, eR) - Math.max(pLeft, eL);
          var eovY = Math.min(pTop, en.y + en.h) - Math.max(pBot, en.y);
          if (eovX > 0 && eovY > 0) {
            if (suitonOn()) { // 波乗り中は波が敵を流す (第25次): 撃破扱い (撃破数・破壊数に加算)
              en.dead = true;
              waveKillCount++;
              breakCount++;
              enemyKillCount++;
              for (var ew = 0; ew < 8; ew++)
                addPart("foam", sx + en.w / 2, GROUND_Y - 14 - Math.random() * 30, (Math.random() - 0.5) * 210, -80 - Math.random() * 140, 0.35 + Math.random() * 0.25, 2.4 + Math.random() * 3, "foam");
              var eg2 = addScore(100, sx, GROUND_Y - en.h - 16);
              addPopup(sx + 2, GROUND_Y - en.h - 32, "波 +" + eg2, "#8ecdf2");
              bumpCombo();
              AudioSys.suitonHit();
              continue;
            }
            if (invincibleT > 0) continue;
            if (eovX < 6 && eovY < 6) { en.grazed = true; continue; } // 角かすり補正 (他障害物と同じ)
            die("敵忍者にやられた"); return;
          }
          // ニアミス (他障害物と同じ規則)
          if (!en.passed && en.x + en.w < pLeft) {
            en.passed = true;
            if (!en.dead) {
              var eClear = pBot - (en.y + en.h);
              if ((eClear >= -4 && eClear < 30) || en.grazed) {
                nearCount++;
                var eg = addScore(100, sx, GROUND_Y - pTop - 26);
                addPopup(playerScreenX() - 20, GROUND_Y - player.y - 52, "ニアミス +" + eg, "#bfe3a8");
                bumpCombo();
                AudioSys.near();
                if (bubbleCd <= 0) { bubbleT = 0.6; bubbleCd = 1.2; }
              }
            }
          }
          continue;
        }
        if (en.kind === "fallrock") {
          /* 前方落下→障害物化 (第15次で仕様変更／第22次で位置関係を再設計):
             通常の落下岩は「狙い落下＋転がり」を廃止し、障害物の出現演出に
             位置づけ直した。第21次まではトリガー距離を速度×1.32+240 (上限
             1760px) と伸ばしたため、上限速度では落下開始が自機の約1700px先
             =画面外になり、影の予告も落ちる様子も見えないまま画面内では
             ただの静止障害物になっていた (実機FB「スピードあげたら落下物が
             ズレて意味なくなってる」)。第22次で位置関係を逆算したが距離
             基準の測定だったため高速帯では影がなお画面外だったので、第23次で
             fallPlan(speed) を画面座標基準に是正した: 着地リード約0.54–0.56秒
             と着地位置 (画面内) は維持したまま、予告影を画面右端へ先行表示
             する prewarn (テレグラフ) を落下開始の前に置き、落下が始まる
             時点では岩本体も画面内に入っているようにした。
             落下中の接触判定は行わない (下の判定は landed のみが対象)。
             着地点は生成時に verifyFallrocks で「穴の上・直前でない／他の
             障害物と重ならない／跳び越え可能」を検証済みの位置だけが残る。
             フェイント岩 (トラップ) も第24次で同じ方式に統一した (落下点は
             チャンクの固定配置のまま動かない) */
          if (en.state === "idle" && en.x > px - 40 && en.x - px <= fallPlan(speed).gap) {
            var fp = fallPlan(speed);
            en.fallG = fp.grav; en.warnDur = fp.warn;
            if (fp.pre > 0.005) { en.state = "prewarn"; en.timer = fp.pre; en.preDur = fp.pre; en.warnPlan = fp.warn; }
            else { en.state = "warn"; en.timer = fp.warn; }
            AudioSys.warn();
          }
          else if (en.state === "prewarn") {
            // 予告影テレグラフ (第23次): 影と「!」を画面右端に先行表示する
            en.timer -= dt;
            if (en.timer <= 0) { en.state = "warn"; en.timer = en.warnPlan || en.warnDur || 0.1; }
          } else if (en.state === "warn") {
            en.timer -= dt;
            if (en.timer <= 0) { en.state = "fall"; en.vy = 0; }
          } else if (en.state === "fall") {
            en.vy += (en.fallG || 2400) * dt; en.dy += en.vy * dt; // dy を落下量として流用。重力は速度帯ごとの落下プラン
            if (en.dy >= 300) {
              en.dy = 300;
              if (!groundAt(en.x + 23)) { en.state = "fallpit"; } // 生成時検証で穴の上は除外済み (保険)
              else {
                en.state = "landed"; // 着地したら通常の地上障害物として残り続ける (消えない)
                addTrauma(0.22); dust(en.x - scroll + 23, GROUND_Y, 8, 1.4);
              }
            }
          } else if (en.state === "fallpit") {
            en.vy += 2400 * dt; en.dy += en.vy * dt;
            if (en.dy > 560) en.dead = true;
          }
          if (en.dead) continue;
          if (en.state !== "landed") continue;
          // 着地した岩は通常の障害物として判定 (下へ)
        }
        if (en.kind === "feintrock") {
          /* フェイント落下岩 (トラップ「揺れる落下岩」・第24次で通常方式に統一):
             かつては予告開始時点で落下点を自機位置へ書き換える狙い落下と、
             着地後に自機方向へ転がる転がりを専用に持っていたが、Kantaの
             指示でどちらも廃止した。通常の落下岩とまったく同じ fallPlan
             (画面座標基準・第23次) で発動し、落下点はチャンクの固定配置
             (生成位置) のまま最後まで動かない。違いは見た目だけ: 待機中から
             上空に岩が見えていて、warn 中は小刻みに揺れる (演出として残す)。
             着地後は転がらず消えもせず、通常の地上障害物として残り続ける。
             落下中の接触判定は通常岩と同じく行わない (判定は landed のみ) */
          if (en.state === "idle" && en.x > px - 40 && en.x - px <= fallPlan(speed).gap) {
            var fp2 = fallPlan(speed);
            en.fallG = fp2.grav; en.warnDur = fp2.warn;
            if (fp2.pre > 0.005) { en.state = "prewarn"; en.timer = fp2.pre; en.preDur = fp2.pre; en.warnPlan = fp2.warn; }
            else { en.state = "warn"; en.timer = fp2.warn; }
            AudioSys.warn();
          }
          else if (en.state === "prewarn") {
            // 予告影テレグラフ (通常岩と同じ): 影と「!」を画面右端に先行表示
            en.timer -= dt;
            if (en.timer <= 0) { en.state = "warn"; en.timer = en.warnPlan || en.warnDur || 0.1; }
          } else if (en.state === "warn") {
            en.timer -= dt;
            if (en.timer <= 0) { en.state = "fall"; en.vy = 0; }
          } else if (en.state === "fall") {
            en.vy += (en.fallG || 2400) * dt; en.dy += en.vy * dt; // 重力は速度帯ごとの落下プラン (通常岩と同じ)
            if (en.dy >= 300) {
              en.dy = 300;
              if (!groundAt(en.x + 23)) { en.state = "fallpit"; } // フェイント岩のチャンクに穴は無い (保険・通常岩と同じ)
              else {
                en.state = "landed"; // 着地したら通常の地上障害物として残り続ける (転がり・消滅なし)
                addTrauma(0.22); dust(en.x - scroll + 23, GROUND_Y, 8, 1.4);
              }
            }
          } else if (en.state === "fallpit") {
            en.vy += 2400 * dt; en.dy += en.vy * dt;
            if (en.dy > 560) en.dead = true;
          }
          if (en.dead) continue;
          if (en.state !== "landed") continue;
          // 着地した岩は通常の障害物として判定 (下へ)
        }
        if (en.kind === "gap") {
          // 波乗りで穴を渡り切ったら数える (第25次・称号判定用)。波の有無に
          // かかわらず、自機中心が穴の遠端を越えた時点で1回だけ記録する
          if (suitonOn() && !en.waveCounted && px > en.x + en.w) { en.waveCounted = true; waveGapCount++; }
          continue;
        }
        if (en.kind === "plat") continue;
        if (en.dead) continue;

        // 障害物の当たり判定 (数px内側に縮小 = 角かすり補正)
        var oL = en.x + 6, oR = en.x + en.w - 6;
        var oB = 0, oT = en.h;
        if (en.kind === "crate") { oL = en.x + 3; oR = en.x + en.w - 3; }
        var overlapX = Math.min(pRight, oR) - Math.max(pLeft, oL);
        var overlapY = Math.min(pTop, oT) - Math.max(pBot, oB);
        if (overlapX > 0 && overlapY > 0) {
          if (suitonOn()) { waveDestroy(en, sx); continue; } // 波乗り中は波が押し流す (第25次): 死なずに消去 (+100・破壊数)
          if (invincibleT > 0) continue; // 無敵中 (おにぎり) はすり抜ける: 死なない・壊れない・減速もしない
          if (en.kind === "crate") {
            if (dashing) {
              en.dead = true;
              breakCount++;
              shards(sx + 23, GROUND_Y - 24);
              hitstop = Math.max(hitstop, 3 / 60);
              addTrauma(0.30);
              var cg = addScore(30, sx, GROUND_Y - 60);
              addPopup(sx + 10, GROUND_Y - 84, "+" + cg, "#f2cd6e");
              bumpCombo();
              AudioSys.brk();
              continue;
            } else if (player.grounded && pTop - oT > 20 && overlapY > 8) {
              // 地上で体当たり: 壊れるが減速 (Canabalt式自己調整)
              en.dead = true;
              shards(sx + 23, GROUND_Y - 24);
              speed = Math.max(SPEED_START * 0.8, speed - 130);
              addTrauma(0.18);
              AudioSys.bump();
              continue;
            } else if (!player.grounded && player.vy <= 0 && pBot >= oT - 12) {
              continue; // 上に乗っている
            } else {
              die("木箱に激突した"); return;
            }
          }
          // 角かすり: 両軸とも浅いめり込みはヒットにしない
          if (overlapX < 6 && overlapY < 6) { en.grazed = true; continue; }
          if (en.kind === "spike") die("竹槍に当たった");
          else if (en.kind === "rock") die("岩に当たった");
          else if (en.kind === "fallrock" || en.kind === "feintrock") die("落ちてきた岩に当たった");
          return;
        }
        // ニアミス: 通過完了時に近接していたら
        if (!en.passed && en.x + en.w < pLeft) {
          en.passed = true;
          if (!en.dead && en.kind !== "crate") {
            var clearanceY = pBot - oT; // 上を越えた場合のクリアランス
            var near = false;
            if (clearanceY >= -4 && clearanceY < 30) near = true; // 頭上すれすれ
            if (en.grazed) near = true;
            if (near) {
              nearCount++;
              var ng = addScore(100, sx, GROUND_Y - pTop - 26);
              addPopup(playerScreenX() - 20, GROUND_Y - player.y - 52, "ニアミス +" + ng, "#bfe3a8"); // 頭上位置はキャラ縮小に比例 (第9次: -71→-52)
              bumpCombo();
              AudioSys.near();
              // ニアミス吹き出し (第12次): 頭上に小さな「……」を約0.6秒。
              // 連発防止にクールダウン約1.2秒
              if (bubbleCd <= 0) { bubbleT = 0.6; bubbleCd = 1.2; }
            }
          }
        }
      }

      // --- 火遁 (第14次・仕様D／第16次で発動前倒し): 周回する火の玉が
      // 前方の障害物を自動で排除。第16次: 「発動が遅く、障害物を過ぎてから
      // 排除される」という実機FBを受け、発射を大幅に前倒しした。射程は
      // 速度連動 (基本速度+360px・800–1440px。第21次: 速度上限の引き上げに
      // 追随し上限を1320→1440に拡大。玉速3000px/sは据え置き) で、対象が
      // 画面右端に入る前後ですぐ発射する。玉の速度も 640→3000px/s に上げ、
      // 排除完了が自機の到達より 0.5 秒以上前になるよう設計した (検証は
      // 設計メモ「火遁の発動前倒し (第16次)」行と第21次の行)。優先順位は自機が最初に到達する
      // 最も近い前方対象。飛行中の玉が狙っている対象は重複して狙わない ---
      if (katonCd > 0) katonCd -= dt;
      var kRange = Math.min(1440, Math.max(800, speed + 360));
      function katonClaimed(te) {
        for (var ci = 0; ci < katonProjectiles.length; ci++)
          if (katonProjectiles[ci].target === te) return true;
        return false;
      }
      function katonFindTarget(maxD) {
        // 最も近い前方対象を探す。落下岩は落下中・転がり中・静止後すべて
        // 対象 (idle の未出現分は除く)。他玉が狙い中の対象は除く
        var bT = null, bD = 1e9;
        for (var ki = 0; ki < entities.length; ki++) {
          var ke = entities[ki];
          if (ke.dead) continue;
          var isRock = ke.kind === "fallrock" || ke.kind === "feintrock";
          if (ke.kind !== "crate" && ke.kind !== "rock" && ke.kind !== "spike" && ke.kind !== "enemy" && !isRock) continue;
          if (isRock && ke.state === "idle") continue;
          if (katonClaimed(ke)) continue;
          var kdx = ke.x + ke.w / 2 - px;
          if (kdx < -30 || kdx > maxD) continue;
          if (kdx < bD) { bD = kdx; bT = ke; }
        }
        return bT;
      }
      if (katonBalls > 0 && katonCd <= 0 && state === "playing") {
        var bestT = katonFindTarget(kRange);
        if (bestT) {
          katonBalls--;
          katonCd = 0.10; // 第16次: 0.38→0.10。連続対象でも間を置かずに撃つ
          throwCount++; // プレイ計測: 火遁の発射回数として記録する
          var itp = katonTargetPoint(bestT);
          var idx = itp[0] - px, idy = itp[1] - (player.y + 34);
          var idd = Math.sqrt(idx * idx + idy * idy) || 1;
          katonProjectiles.push({ x: px, h: player.y + 34, vx: idx / idd * 1700, vh: idy / idd * 1700, target: bestT, life: 1.6, dead: false });
          AudioSys.katonFire();
        }
      }
      for (var kp = katonProjectiles.length - 1; kp >= 0; kp--) {
        var kb = katonProjectiles[kp];
        kb.life -= dt;
        var tgt = kb.target;
        if (!tgt || tgt.dead) {
          // 第16次: 対象が他の玉に先に排除されたら、無駄玉にせず次に
          // 最も近い対象へ向かわせる。近くに対象がなければ燃え尽きる
          var reT = (state === "playing") ? katonFindTarget(1400) : null;
          if (reT) { kb.target = reT; tgt = reT; kb.life = Math.max(kb.life, 0.8); }
          else kb.dead = true;
        }
        if (!kb.dead) {
          var tp = katonTargetPoint(tgt);
          var tx = tp[0] - kb.x, ty = tp[1] - kb.h;
          var td = Math.sqrt(tx * tx + ty * ty) || 1;
          var spd = 3000; // 第16次: 640→3000。遠方発射でも到達前に排除が完了する速さ
          var dvx = tx / td * spd, dvy = ty / td * spd;
          var steer = 16 * dt; // 追尾の旋回 (玉が対象へ吸い付くように寄せる)
          kb.vx += (dvx - kb.vx) * Math.min(1, steer);
          kb.vh += (dvy - kb.vh) * Math.min(1, steer);
          kb.x += kb.vx * dt;
          kb.h += kb.vh * dt;
          if (Math.random() < 0.6) addPart("fire", kb.x - scroll, GROUND_Y - kb.h, -40, -30, 0.28, 2.6, "fire");
          if (td < 36) {
            // 排除: 従来の破壊と同じ扱い (+100点・倍率寄与・破壊数カウント)
            tgt.dead = true;
            kb.dead = true;
            katonKillCount++;
            if (tgt.kind === "enemy") enemyKillCount++; // 称号判定用 (第19次)
            breakCount++;
            var ksx = tgt.x - scroll;
            if (tgt.kind === "crate") shards(ksx + 23, GROUND_Y - 24);
            for (var kf2 = 0; kf2 < 10; kf2++)
              addPart("fire", ksx + tgt.w / 2, GROUND_Y - tp[1], (Math.random() - 0.5) * 220, -40 - Math.random() * 160, 0.35 + Math.random() * 0.3, 3 + Math.random() * 3, "fire");
            inkBurst(ksx + tgt.w / 2, GROUND_Y - tp[1], 8);
            hitstop = Math.max(hitstop, 3 / 60);
            addTrauma(0.20);
            var kg = addScore(100, ksx, GROUND_Y - tp[1] - 26);
            addPopup(ksx + 2, GROUND_Y - tp[1] - 30, "火遁 +" + kg, "#ff9d5c");
            bumpCombo();
            AudioSys.katonHit();
          }
        }
        if (kb.life <= 0) kb.dead = true;
        if (kb.dead) katonProjectiles.splice(kp, 1);
      }

      /* --- 風遁の竜巻 (第25次): 取得した瞬間に前方へ1発。自機より速く
         (自機の現在速度+700px/s) 前進し、進路上の障害物をすべて巻き上げて
         消去する (地上障害物・落下岩 (出現済みのもの)・敵忍者。+100点・
         倍率寄与・破壊数カウント、敵は撃破数にも加算)。落とし穴 (地形) は
         消せない。約200m進むか画面の先へ出たら消える。竜巻は自機のはるか
         前方を進むため、消去は常に対象への到達前に完了し、不公平は生じない --- */
      for (var ti = tornadoes.length - 1; ti >= 0; ti--) {
        var tn = tornadoes[ti];
        tn.x += (curSpeed + 700) * dt;
        for (var tj = 0; tj < entities.length; tj++) {
          var te2 = entities[tj];
          if (te2.dead) continue;
          var isRock2 = te2.kind === "fallrock" || te2.kind === "feintrock";
          if (te2.kind !== "crate" && te2.kind !== "rock" && te2.kind !== "spike" && te2.kind !== "enemy" && !isRock2) continue;
          if (isRock2 && te2.state === "idle") continue; // まだ現れていない落下岩は対象外 (火遁と同じ)
          if (Math.abs(te2.x + te2.w / 2 - tn.x) > 52) continue;
          te2.dead = true;
          tn.kills++;
          fuutonKillCount++;
          if (tn.kills > fuutonMaxChain) fuutonMaxChain = tn.kills;
          breakCount++;
          if (te2.kind === "enemy") enemyKillCount++; // 撃破扱い (第25次)
          var tp2 = katonTargetPoint(te2);
          var tsx = te2.x - scroll;
          if (te2.kind === "crate") shards(tsx + 23, GROUND_Y - 24);
          for (var tf = 0; tf < 8; tf++) // 巻き上げられる破片は上へ強く飛ぶ
            addPart("shard", tsx + te2.w / 2, GROUND_Y - tp2[1], (Math.random() - 0.5) * 170, -260 - Math.random() * 260, 0.5 + Math.random() * 0.3, 3.5 + Math.random() * 5, "wood");
          inkBurst(tsx + te2.w / 2, GROUND_Y - tp2[1], 6);
          var tg2 = addScore(100, tsx, GROUND_Y - tp2[1] - 26);
          addPopup(tsx + 2, GROUND_Y - tp2[1] - 30, "風遁 +" + tg2, "#a8e6c8");
          bumpCombo();
          AudioSys.fuutonHit();
        }
        if (tn.x - tn.spawnX > 200 * PX_PER_M || tn.x - scroll > W + 700) tornadoes.splice(ti, 1);
      }

      // --- 敵忍者の出現 (第14次・仕様F／第17次で2周目以降は常時化) ---
      // 1周目: 従来どおり月夜帯のみ。2周目以降 (lap>=1): 景色の帯を問わず
      // 常時、判定ごとにランダム出現を試みる。判定間隔は周回で少し短くなるが
      // 下限3.2秒を割らない (過密防止の上限)。出現可否の公平性 (穴の上・直前
      // に出さない／他の障害物と重ねない／遭遇地点が平地) は trySpawnEnemy が
      // 従来どおり担保し、出せない時は出さない (間隔だけ空けて次回に回す)
      if (enemyTimer > 0) enemyTimer -= dt;
      if (enemyTimer <= 0) {
        var lapNow = lapAt(scroll / PX_PER_M);
        enemyTimer = Math.max(3.2, 6.5 - lapNow * 0.7) + Math.random() * 2.5; // 次回判定 (出現しなくても間隔は空ける)
        if (lapNow >= 1 || bandIndex(scroll / PX_PER_M) === 3) trySpawnEnemy(px);
      }

      // チャンク補充
      while (nextChunkAt < scroll + W + 900) spawnChunk();
      // 現在チャンク表示
      for (var z = 0; z < chunkZones.length; z++) {
        if (px >= chunkZones[z].x0 && px < chunkZones[z].x1) {
          curChunkName = chunkZones[z].name; curChunkDiff = chunkZones[z].diff;
          break;
        }
      }
      if (chunkZones.length && chunkZones[0].x1 < scroll - 100) chunkZones.shift();

      // スコア: 距離
      score += curSpeed * dt / PX_PER_M;

      // 巻物チャレンジの達成判定 (第12次): 達成した瞬間に表示＋SE＋ボーナス。
      // 達成してもランは続く (1ラン1ミッション)
      if (mission && !mission.done && missionProgress() >= mission.target) {
        mission.done = true;
        score += 300;
        addPopup(playerScreenX() - 30, GROUND_Y - player.y - 76, "巻物達成！ +300", "#ffd97a");
        inkRing(playerScreenX(), GROUND_Y - player.y - 8);
        AudioSys.missionClear();
        updateHud();
      }

      // パーティクル
      for (var q = parts.length - 1; q >= 0; q--) {
        var pt = parts[q];
        pt.life -= dt;
        if (pt.life <= 0) { parts.splice(q, 1); continue; }
        pt.x += pt.vx * dt - curSpeed * dt * (pt.kind === "smoke" ? 0.25 : 0.55);
        pt.y += pt.vy * dt;
        if (pt.kind === "shard") pt.vy += 1500 * dt;
        if (pt.kind === "dot") pt.vy += 300 * dt;
        if (pt.kind === "foam") pt.vy += 520 * dt; // 泡・水しぶき (第25次): 少し速く落ちる
        if (pt.kind === "fire") pt.vy -= 260 * dt; // 炎は上へ (第14次)
      }
      for (var u = popups.length - 1; u >= 0; u--) {
        popups[u].life -= dt; popups[u].y -= 34 * dt;
        if (popups[u].life <= 0) popups.splice(u, 1);
      }

      // カメラ縦: 着地スナップ気味に追従 (ジャンプ中は動かさない)
      var camTarget = player.grounded ? clamp(player.y * 0.35, 0, 60) : camY;
      camY = lerp(camY, camTarget, player.grounded ? 0.30 : 0.04);

      // trauma減衰 (目安 1.2-1.8/s → 1.4)
      trauma = Math.max(0, trauma - 1.4 * dt);
      shakeT += dt;

      AudioSys.setIntensity(clamp(speed / speedCapAt(scroll), 0, 1));
    }

    /* ---------------- 描画 ---------------- */
    /* ステージ内は和紙色の明るい空で固定する (黒キャラが背景に溶けないよう、
       OSのダークモードでもステージ描画は明るいパレットを使う) */
    var darkMode = false;
    function noise1(t) { return Math.sin(t * 31.7) * 0.55 + Math.sin(t * 17.3 + 1.7) * 0.45; }

    function draw(interpScroll, interpY, interpCamY) {
      var sc = interpScroll;
      var bsc = Math.round(sc); // 背景レイヤーは整数pxにスナップ (サブピクセルの滲み・震え防止)
      // ビューポートが16:9と違う分だけ景色を左右/上下に拡張する範囲 (論理座標)
      var extL = -viewOX / viewScale, extR = W + viewOX / viewScale;
      var extT = -viewOY / viewScale, extB = H + viewOY / viewScale;
      curExtL = extL; curExtR = extR; // タイルのロール範囲 (blitLayer が参照)
      // 距離帯テーマ (第12次): 現在のテーマ混合を決める。色だけを混ぜ、
      // 幾何・スクロール・吸着には一切触れない
      var tb = themeBlend(Math.max(0, sc / PX_PER_M));
      var palA = THEMES[tb.a], palB = THEMES[tb.b];
      nightF = (tb.a === 3 ? 1 - tb.f : 0) + (tb.b === 3 ? tb.f : 0);
      var skyMix = mixHex(palA.sky, palB.sky, tb.f);
      // 空: グラデーションの滲みをやめ、フラットな単色でキャンバス全体を塗る
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = skyMix;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(viewScale, 0, 0, viewScale, viewOX, viewOY);
      ctx.fillStyle = skyMix;
      ctx.fillRect(extL, extT - 60, extR - extL, H - extT + 60);

      ctx.save();
      // traumaシェイク: 基礎カメラ + そのフレームだけ合成 (Eiserloh)
      var shake = trauma * trauma;
      if (shake > 0.001) {
        var ox = 14 * shake * noise1(shakeT * 27);
        var oy = 8 * shake * noise1(shakeT * 23 + 40);
        ctx.translate(ox, oy);
        ctx.rotate((1.4 * Math.PI / 180) * shake * noise1(shakeT * 21 + 80));
      }
      var camOff = interpCamY;

      // 天体 (構図C: 右上) — 第19次で三日月を廃止し、帯に連動させた:
      // 竹林・岩場=太陽 (円盤+光条) / 夕景=橙の夕日 / 月夜=満月 (満円+淡い影)。
      // 位置 (716,88) と円盤半径38は従来どおり。色・光条の強さ (rays)・
      // 月の影 (crater) はテーマパレットの混合率 tb.f でなめらかに移ろう
      ctx.save();
      var bodyCol = mixHex(palA.moon, palB.moon, tb.f);
      var rayMix = (palA.rays || 0) * (1 - tb.f) + (palB.rays || 0) * tb.f;
      var craterMix = (palA.crater || 0) * (1 - tb.f) + (palB.crater || 0) * tb.f;
      // ほのかな暈 (かさ): 天体の色で薄く広げる
      var halo = ctx.createRadialGradient(716, 88, 30, 716, 88, 86);
      halo.addColorStop(0, "rgba(255,236,180,0.34)");
      halo.addColorStop(1, "rgba(255,236,180,0)");
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(716, 88, 86, 0, Math.PI * 2); ctx.fill();
      // 光条 (太陽の帯だけ。夕景では弱く、月夜では出ない)
      if (rayMix > 0.02) {
        ctx.strokeStyle = bodyCol; ctx.globalAlpha = rayMix * 0.6;
        ctx.lineWidth = 4.5; ctx.lineCap = "round";
        for (var ri = 0; ri < 8; ri++) {
          var ra = ri * Math.PI / 4 + 0.39;
          ctx.beginPath();
          ctx.moveTo(716 + Math.cos(ra) * 47, 88 + Math.sin(ra) * 47);
          ctx.lineTo(716 + Math.cos(ra) * 62, 88 + Math.sin(ra) * 62);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      // 円盤 (常時満円。三日月の切り欠きは作らない)
      ctx.beginPath(); ctx.arc(716, 88, 38, 0, Math.PI * 2);
      ctx.fillStyle = bodyCol;
      ctx.fill();
      // 満月の淡い影 (月夜の帯だけ): 円盤の内側に柔らかい濃淡を置く
      if (craterMix > 0.02) {
        ctx.fillStyle = "rgba(120,118,105," + (0.20 * craterMix).toFixed(3) + ")";
        ctx.beginPath(); ctx.arc(702, 78, 9, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(728, 100, 12, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(710, 108, 6, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      // 流れる雲 (最遠パララックス 0.08): スロット決定的タイルをロール。
      // テーマ移行中は2テーマのタイルを alpha 合成する (形・位置は同一)
      blitLayer(BG_CLOUD, sc, 0, tb.a, 1);
      if (tb.f > 0) blitLayer(BG_CLOUD, sc, 0, tb.b, tb.f);

      // 遠景の山 (パララックス 0.2) / 中景の竹林 (パララックス 0.5):
      // いずれもスロット決定的タイルのロール描画 (Y は定数、X はデバイスpxスナップ)
      blitLayer(BG_MOUNT, sc, camOff, tb.a, 1);
      if (tb.f > 0) blitLayer(BG_MOUNT, sc, camOff, tb.b, tb.f);
      blitLayer(BG_BAMBOO, sc, camOff, tb.a, 1);
      if (tb.f > 0) blitLayer(BG_BAMBOO, sc, camOff, tb.b, tb.f);

      ctx.translate(0, camOff);

      // 地面: 穴を除いて描く
      var gaps = [];
      for (var gi = 0; gi < entities.length; gi++) if (entities[gi].kind === "gap") gaps.push(entities[gi]);
      var groundMix = mixHex(palA.ground, palB.ground, tb.f); // 地面の色もテーマで移ろう (第12次)
      var groundLineMix = mixHex(palA.groundLine, palB.groundLine, tb.f);
      ctx.fillStyle = groundMix;
      var segStart = extL;
      var sorted = gaps.map(function (g) { return [g.x - sc, g.x + g.w - sc]; })
        .filter(function (r) { return r[1] > extL && r[0] < extR; })
        .sort(function (a, b) { return a[0] - b[0]; });
      for (var si = 0; si <= sorted.length; si++) {
        var segEnd = si < sorted.length ? sorted[si][0] : extR;
        if (segEnd > segStart) {
          ctx.fillRect(segStart, GROUND_Y, segEnd - segStart, extB - GROUND_Y + 90);
          // 地面の上の墨線
          ctx.fillStyle = groundLineMix;
          ctx.fillRect(segStart, GROUND_Y, segEnd - segStart, 5);
          ctx.fillStyle = groundMix;
        }
        if (si < sorted.length) segStart = sorted[si][1];
      }
      // 穴の縁 (視認性パス・第11次): 墨色の太い縁＋地面の唇に赤い警告帯で、
      // 地面の切れ目が即座に読めるようにする
      for (var hi = 0; hi < sorted.length; hi++) {
        ctx.fillStyle = "#100d08";
        ctx.fillRect(sorted[hi][0] - 3, GROUND_Y, 6, 34);
        ctx.fillRect(sorted[hi][1] - 3, GROUND_Y, 6, 34);
        ctx.fillStyle = "rgba(179,55,42,0.92)";
        ctx.fillRect(sorted[hi][0] - 12, GROUND_Y, 12, 6);
        ctx.fillRect(sorted[hi][1], GROUND_Y, 12, 6);
      }
      // 地面の質感ストローク＋地面ライン際の草むら: スロット決定的タイルを
      // 地面と同じ速度 (パララックス 1.0) でロールさせる
      blitLayer(BG_GROUND, sc, 0, tb.a, 1);
      if (tb.f > 0) blitLayer(BG_GROUND, sc, 0, tb.b, tb.f);
      // 落とし穴の底: 穴の区間は地面タイルごと欠け、暗い底を見せる
      ctx.fillStyle = darkMode ? "#060505" : "#14100b";
      for (var pi3 = 0; pi3 < sorted.length; pi3++) {
        ctx.fillRect(sorted[pi3][0], GROUND_Y, sorted[pi3][1] - sorted[pi3][0], extB - GROUND_Y + 90);
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(sorted[pi3][0], GROUND_Y, sorted[pi3][1] - sorted[pi3][0], 20);
        ctx.fillStyle = "#100d08";
        ctx.fillRect(sorted[pi3][0] - 3, GROUND_Y, 6, 34);
        ctx.fillRect(sorted[pi3][1] - 3, GROUND_Y, 6, 34);
        ctx.fillStyle = "rgba(179,55,42,0.92)";
        ctx.fillRect(sorted[pi3][0] - 12, GROUND_Y, 12, 6);
        ctx.fillRect(sorted[pi3][1], GROUND_Y, 12, 6);
        ctx.fillStyle = darkMode ? "#060505" : "#14100b";
      }

      // エンティティ
      for (var ei = 0; ei < entities.length; ei++) {
        var e = entities[ei];
        var x = e.x - sc;
        if (x + Math.max(e.w, 40) < -60 || x > W + 80) continue;
        if (e.kind === "gap") continue;
        if (e.kind === "orb") { if (!e.dead) drawOrb(x + 10, GROUND_Y - e.dy); continue; }
        if (e.kind === "onigiri") { if (!e.dead) drawOnigiri(x + 20, GROUND_Y - e.dy + Math.sin(elapsed * 3 + x * 0.04) * 3); continue; }
        if (e.kind === "bunshin") { if (!e.dead) drawBunshinItem(x + 20, GROUND_Y - e.dy + Math.sin(elapsed * 3 + x * 0.04) * 3); continue; }
        if (e.kind === "katon") { if (!e.dead) drawKatonItem(x + 20, GROUND_Y - e.dy + Math.sin(elapsed * 3 + x * 0.04) * 3); continue; }
        if (e.kind === "suiton") { if (!e.dead) drawSuitonItem(x + 20, GROUND_Y - e.dy + Math.sin(elapsed * 3 + x * 0.04) * 3); continue; }
        if (e.kind === "fuuton") { if (!e.dead) drawFuutonItem(x + 20, GROUND_Y - e.dy + Math.sin(elapsed * 3 + x * 0.04) * 3); continue; }
        if (e.kind === "enemy") { if (!e.dead) drawEnemy(x, e); continue; }
        if (e.kind === "plat") { drawPlatform(x, GROUND_Y - e.h, e.w); continue; }
        if (e.kind === "spike") { if (!e.dead) { drawObstacleShadow(x + e.w / 2, e.w); drawSpike(x, e.w, e.h); } continue; }
        if (e.kind === "rock") { if (!e.dead) { drawObstacleShadow(x + e.w / 2, e.w); drawRock(x, GROUND_Y, e.w, e.h); } continue; }
        if (e.kind === "crate") { if (!e.dead) { drawObstacleShadow(x + e.w / 2, e.w); drawCrate(x, GROUND_Y - e.h, e.w, e.h); } continue; }
        if (e.kind === "fallrock") { drawFallrock(e, x); continue; }
        if (e.kind === "feintrock") { drawFeintrock(e, x); continue; }
      }

      // 火遁: 追尾中の火の玉 (第14次)
      for (var qi = 0; qi < katonProjectiles.length; qi++) {
        var qp = katonProjectiles[qi];
        drawFireBall(qp.x - sc, GROUND_Y - qp.h, 9);
      }
      // 風遁: 進む竜巻 (第25次)。地面から立ち上る渦を、幅の違う楕円の
      // 重なり＋渦巻き線で描く。回転位相は visualTime で進める
      for (var wi = 0; wi < tornadoes.length; wi++) {
        var wx = tornadoes[wi].x - sc;
        if (wx < -90 || wx > W + 90) continue;
        ctx.save();
        for (var wl = 0; wl < 6; wl++) {
          var wy = GROUND_Y - 8 - wl * 19;
          var ww = 15 + wl * 6.5;
          var wob = Math.sin(visualTime * 13 + wl * 1.35) * (3 + wl);
          ctx.beginPath(); ctx.ellipse(wx + wob, wy, ww, 8.5, 0, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(214,236,244," + (0.30 + wl * 0.055).toFixed(3) + ")";
          ctx.fill();
          ctx.strokeStyle = "rgba(90,140,160,0.5)"; ctx.lineWidth = 1.6; ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(wx + Math.sin(visualTime * 13) * 4, GROUND_Y - 122, 13, visualTime * 9, visualTime * 9 + Math.PI * 1.35);
        ctx.strokeStyle = "rgba(90,140,160,0.65)"; ctx.lineWidth = 2.4; ctx.stroke();
        ctx.restore();
      }
      // 変わり身の丸太 (第14次): 発動地点に残り、煙に包まれて消えていく
      if (kawarimiFx) {
        var logX = kawarimiFx.wx - sc;
        if (logX > -60 && logX < W + 60) drawLog(logX, GROUND_Y - kawarimiFx.y, clamp(kawarimiFx.t / 0.85, 0, 1));
      }

      // パーティクル
      for (var pi = 0; pi < parts.length; pi++) {
        var p = parts[pi];
        var a = clamp(p.life / p.maxLife, 0, 1);
        if (p.kind === "smoke") {
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.6 - a * 0.6), 0, Math.PI * 2);
          ctx.fillStyle = darkMode ? "rgba(220,212,195," + (0.30 * a) + ")" : "rgba(70,64,54," + (0.32 * a) + ")";
          ctx.fill();
        } else if (p.kind === "ring") {
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size + (1 - a) * 26, 0, Math.PI * 2);
          ctx.strokeStyle = darkMode ? "rgba(236,228,208," + (0.55 * a) + ")" : "rgba(33,28,20," + (0.5 * a) + ")";
          ctx.lineWidth = 2.2; ctx.stroke();
        } else if (p.kind === "shard") {
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.seed + p.life * 9);
          ctx.fillStyle = "rgba(154,123,82," + a + ")"; ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
          ctx.restore();
        } else if (p.kind === "fire") {
          // 炎のパーティクル (第14次): 外側は橙、芯は淡黄でゆらめかせる
          var fl = 0.8 + Math.sin(visualTime * 31 + p.seed * 7) * 0.2;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * a * fl + 0.4, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(232,106,40," + (0.75 * a) + ")"; ctx.fill();
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * a * 0.45, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(246,196,83," + (0.85 * a) + ")"; ctx.fill();
        } else if (p.kind === "foam") {
          // 泡・水しぶき (第25次): 水色の芯＋白い縁で、水の粒として読ませる
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * a + 0.4, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(120,180,225," + (0.75 * a) + ")"; ctx.fill();
          ctx.beginPath(); ctx.arc(p.x - p.size * 0.25, p.y - p.size * 0.25, p.size * a * 0.42 + 0.3, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(240,250,255," + (0.85 * a) + ")"; ctx.fill();
        } else {
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * a + 0.4, 0, Math.PI * 2);
          ctx.fillStyle = darkMode ? "rgba(236,228,208," + (0.75 * a) + ")" : "rgba(33,28,20," + (0.7 * a) + ")";
          ctx.fill();
        }
      }

      // 高速時のスピード線
      if (speed > 690 && state === "playing") {
        ctx.strokeStyle = darkMode ? "rgba(236,228,208,0.16)" : "rgba(33,28,20,0.14)";
        ctx.lineWidth = 2;
        var nLines = ((speed - 690) / 40) | 0;
        for (var li = 0; li < nLines; li++) {
          var ly = ((li * 137 + ((sc * 2.2) % 300)) % (GROUND_Y - 60)) + 20;
          var lx = W - ((sc * 2.6 + li * 260) % (W + 240)) + 120;
          ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx - 54, ly); ctx.stroke();
        }
      }

      // プレイヤー
      drawPlayer(playerScreenX(), GROUND_Y - interpY, interpY);

      // タイトル画面だけ: 頭上に名前マーカー (走っているのが誰か一目で分かるように)
      if (state === "title") {
        var mkX = playerScreenX(), mkY = GROUND_Y - interpY - 117 + Math.sin(visualTime * 3.2) * 5; // 小さくなった頭の直上に追随 (第9次: -159→-117、縮小に比例)
        ctx.font = "900 16px 'Zen Kaku Gothic New', sans-serif";
        ctx.textAlign = "center";
        var mkW = 74, mkH = 28;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(mkX - mkW / 2, mkY - mkH, mkW, mkH, 7); else ctx.rect(mkX - mkW / 2, mkY - mkH, mkW, mkH);
        ctx.fillStyle = "#b3372a"; ctx.fill();
        ctx.beginPath(); ctx.moveTo(mkX - 7, mkY); ctx.lineTo(mkX + 7, mkY); ctx.lineTo(mkX, mkY + 10); ctx.closePath(); ctx.fill();
        ctx.fillStyle = "#fff8ea";
        ctx.fillText("すみ忍", mkX, mkY - 8);
      }

      // ポップアップ (第8次: 背景に溶けないよう濃色の縁取りを先に描く)
      ctx.font = "900 17px 'Zen Kaku Gothic New', sans-serif";
      ctx.textAlign = "center";
      for (var ui = 0; ui < popups.length; ui++) {
        var pp = popups[ui];
        ctx.globalAlpha = clamp(pp.life / 0.85, 0, 1);
        ctx.lineWidth = 4; ctx.lineJoin = "round";
        ctx.strokeStyle = "rgba(16,12,6,0.88)";
        ctx.strokeText(pp.text, pp.x, pp.y);
        ctx.fillStyle = pp.col;
        ctx.fillText(pp.text, pp.x, pp.y);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    /* ---------------- 距離帯テーマ (第12次) ----------------
       距離帯で景色の「色」だけが移ろう: 0–300m 竹林 (現行パレット) /
       300–700m 岩場 / 700–1200m 夕景 / 1200m– 月夜。帯の境界の手前
       約50mで次のパレットへクロスフェードする (タイルはテーマ別に
       キャッシュし、移行中だけ2テーマ分を alpha 合成する)。
       【厳守】背景の幾何・スクロール計算・タイル方式・デバイスpx吸着は
       一切変えず、変えるのはパレット (色) だけ。タイルの生成関数も
       形は従来どおりで、色だけ tilePal から取る。キャラの墨の濃さ
       システムには影響させない。月夜では障害物・墨玉の縁を明るく
       保つため、混合率 nightF を描画側が保持する */
    var THEMES = [
      { name: "竹林", sky: "#f0e3c0", cloud: "#fffaf0", cloudLine: "rgba(33,28,20,0.35)", mount: "#9c8a64", bamboo: "#46543a", ground: "#3a342a", groundLine: "#211c14", groundTex: "rgba(33,28,20,0.13)", grass: "rgba(70,86,54,0.38)", moon: "#d9a62e", rays: 1, crater: 0 },
      { name: "岩場", sky: "#e9dcc0", cloud: "#f7efdc", cloudLine: "rgba(60,54,44,0.35)", mount: "#767065", bamboo: "#5f6852", ground: "#453d33", groundLine: "#2a251d", groundTex: "rgba(30,26,20,0.16)", grass: "rgba(96,94,70,0.38)", moon: "#d9a62e", rays: 1, crater: 0 },
      { name: "夕景", sky: "#f4b183", cloud: "#ffd9a8", cloudLine: "rgba(120,60,30,0.35)", mount: "#8a5a44", bamboo: "#4c4636", ground: "#4a3628", groundLine: "#2e2019", groundTex: "rgba(40,20,10,0.18)", grass: "rgba(90,70,40,0.40)", moon: "#ef8f3a", rays: 0.3, crater: 0 },
      { name: "月夜", sky: "#26304a", cloud: "#aebadd", cloudLine: "rgba(10,14,26,0.50)", mount: "#39415c", bamboo: "#26314a", ground: "#31364a", groundLine: "#171a26", groundTex: "rgba(220,228,255,0.13)", grass: "rgba(140,160,200,0.35)", moon: "#ece4d0", rays: 0, crater: 1 }
    ];
    var BAND_UNTIL = [300, 700, 1200, 1600]; // 1周内での各帯の終端 (m)。1600mで周回する (第14次)
    var BAND_FADE = 50; // クロスフェード区間 (m)
    var tilePal = THEMES[0]; // タイル生成時に使う現在のパレット (getTile がテーマごとに差し替える)
    function bandInfo(dist) {
      var lap = lapAt(dist);
      var d = Math.max(0, dist) - lap * LAP_M;
      for (var i = 0; i < BAND_UNTIL.length; i++) if (d < BAND_UNTIL[i]) return { lap: lap, idx: i, d: d };
      return { lap: lap, idx: 3, d: d };
    }
    function bandIndex(dist) { return bandInfo(dist).idx; }
    function bandName(dist) {
      var bi = bandInfo(dist);
      return THEMES[bi.idx].name + (bi.lap >= 1 ? " " + (bi.lap + 1) + "周目" : "");
    }
    function themeBlend(dist) {
      var bi = bandInfo(dist), d = bi.d;
      for (var i = 0; i < BAND_UNTIL.length - 1; i++) {
        var u = BAND_UNTIL[i];
        if (d < u - BAND_FADE) return { a: i, b: i, f: 0 };
        if (d < u) return { a: i, b: i + 1, f: (d - (u - BAND_FADE)) / BAND_FADE };
      }
      // 月夜の終盤は次の周の竹林へクロスフェードする (周回・第14次)
      if (d < LAP_M - BAND_FADE) return { a: 3, b: 3, f: 0 };
      return { a: 3, b: 0, f: (d - (LAP_M - BAND_FADE)) / BAND_FADE };
    }
    function mixHex(h1, h2, t) {
      if (t <= 0) return h1;
      if (t >= 1) return h2;
      var r1 = parseInt(h1.slice(1, 3), 16), g1 = parseInt(h1.slice(3, 5), 16), b1 = parseInt(h1.slice(5, 7), 16);
      var r2 = parseInt(h2.slice(1, 3), 16), g2 = parseInt(h2.slice(3, 5), 16), b2 = parseInt(h2.slice(5, 7), 16);
      return "rgb(" + Math.round(lerp(r1, r2, t)) + "," + Math.round(lerp(g1, g2, t)) + "," + Math.round(lerp(b1, b2, t)) + ")";
    }

    /* ---------------- 背景タイル (Phase 1+2: スロット同一性 + 静止画ロール) ----------------
       全背景オブジェクト (雲・山・竹・地面の質感・草) は、ワールドのスロット番号
       ＋固定シードからの決定的生成 (純関数) でオフスクリーンCanvasのタイルに
       事前描画し、drawImage でロールさせる。同じスロットはスクロールしても
       形・高さ・位置が不変で、往復スクロールでも絵が完全復元する。
       タイルのY (layer.top) はレイヤー定義時の定数で毎フレーム再計算しない。
       Xオフセットだけをデバイスpx単位でスナップする (snapDev)。 */
    var TILE_W = 512; // 論理px。デバイス幅は tileScale 倍で 2048 以下 (iOS 4096 制限対策)
    var tileCache = new Map();
    var curExtL = -80, curExtR = W + 80;
    function hash2(a, b) {
      var h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return (h ^ (h >>> 16)) >>> 0;
    }
    function slotRng(seed, slot) { return mulberry32(hash2(seed, slot)); }
    /* デバイスpxスナップ: 内部の補間 (float) は保持し、最終描画位置だけを
       デバイスピクセルの格子に丸める。S = viewScale (論理→デバイス総倍率) */
    function snapDev(p) { return Math.round(p * viewScale) / viewScale; }

    function genCloudTile(g, rng) {
      var n = 1 + Math.floor(rng() * 2);
      for (var i = 0; i < n; i++) {
        var cx = rng() * 400, cy = 28 + rng() * 82, cw = 170 + rng() * 130;
        for (var rep = -1; rep <= 1; rep++) { // 端を跨ぐ雲は隣タイル側にも同じ形を描く
          var ox = cx + rep * TILE_W;
          if (ox + cw < -10 || ox > TILE_W + 10) continue;
          g.fillStyle = tilePal.cloud; // テーマパレット (第12次): 形は不変、色だけ
          g.beginPath(); g.ellipse(ox + cw / 2, cy + 8, cw / 2, 10, 0, 0, Math.PI * 2); g.fill();
          g.beginPath(); g.ellipse(ox + cw * 0.32, cy - 2, cw * 0.20, 13, 0, 0, Math.PI * 2); g.fill();
          g.beginPath(); g.ellipse(ox + cw * 0.58, cy - 6, cw * 0.24, 16, 0, 0, Math.PI * 2); g.fill();
          g.beginPath(); g.ellipse(ox + cw * 0.80, cy + 1, cw * 0.15, 10, 0, 0, Math.PI * 2); g.fill();
          g.strokeStyle = tilePal.cloudLine;
          g.lineWidth = 2;
          g.beginPath(); g.moveTo(ox + 8, cy + 14); g.lineTo(ox + cw - 8, cy + 14); g.stroke();
        }
      }
    }
    function genMountTile(g, rng) {
      var Hh = 208, edge = 66; // 両端の稜線高さは全スロット共通 → 継ぎ目が連続する
      var pts = [[0, edge]];
      var peaks = 2 + Math.floor(rng() * 2);
      var lastX = 0;
      for (var i = 0; i < peaks; i++) {
        var px = (i + 0.5) * (TILE_W / peaks) + (rng() - 0.5) * 60;
        var ph = 118 + rng() * 52;
        var xs = [px - 60 - rng() * 30, px, px + 60 + rng() * 30];
        var hs = [66 + rng() * 30, ph, 66 + rng() * 30];
        for (var k = 0; k < 3; k++) {
          var xx = Math.max(xs[k], lastX + 8);
          pts.push([xx, hs[k]]); lastX = xx;
        }
      }
      pts.push([TILE_W, edge]);
      g.fillStyle = tilePal.mount;
      g.beginPath();
      g.moveTo(0, Hh);
      for (var j = 0; j < pts.length; j++) g.lineTo(pts[j][0], Hh - pts[j][1]);
      g.lineTo(TILE_W, Hh);
      g.closePath(); g.fill();
    }
    function drawBambooAt(g, x, baseY, h, thick) {
      g.strokeStyle = tilePal.bamboo;
      g.lineWidth = thick;
      g.beginPath(); g.moveTo(x, baseY); g.lineTo(x, baseY - h); g.stroke();
      g.lineWidth = 2;
      for (var i = 1; i <= 3; i++) {
        g.beginPath(); g.moveTo(x - 4, baseY - h * i / 3.4); g.lineTo(x + 4, baseY - h * i / 3.4); g.stroke();
      }
      g.fillStyle = tilePal.bamboo;
      g.beginPath(); g.ellipse(x + 14, baseY - h + 8, 16, 6, 0.5, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(x - 12, baseY - h + 26, 13, 5, -0.5, 0, Math.PI * 2); g.fill();
    }
    function genBambooTile(g, rng) {
      var n = 4 + Math.floor(rng() * 2);
      for (var i = 0; i < n; i++) {
        var x = 16 + rng() * (TILE_W - 32);
        var h = 150 + rng() * 95, th = 6 + rng() * 2;
        drawBambooAt(g, x, 268, h, th);
        if (x < 34) drawBambooAt(g, x + TILE_W, 268, h, th);
        if (x > TILE_W - 34) drawBambooAt(g, x - TILE_W, 268, h, th);
      }
    }
    function genGroundTile(g, rng) {
      // タイル内座標: 地面ラインは y=14 (layer.top = GROUND_Y-14)
      g.strokeStyle = tilePal.groundTex;
      g.lineWidth = 2;
      var rows = [40, 70, 100]; // GROUND_Y+26 / +56 / +86 に対応
      for (var r = 0; r < rows.length; r++) {
        for (var i = 0; i < 2; i++) {
          var x = rng() * (TILE_W - 60), len = 30 + rng() * 24;
          g.beginPath(); g.moveTo(x, rows[r]); g.lineTo(x + len, rows[r]); g.stroke();
        }
      }
      g.strokeStyle = tilePal.grass;
      g.lineWidth = 1.8;
      var tufts = 3 + Math.floor(rng() * 2);
      for (var t = 0; t < tufts; t++) {
        var gx = 10 + rng() * (TILE_W - 20);
        g.beginPath(); g.moveTo(gx, 15); g.lineTo(gx - 4, 5 + rng() * 3); g.stroke();
        g.beginPath(); g.moveTo(gx + 4, 15); g.lineTo(gx + 5, 3 + rng() * 3); g.stroke();
        g.beginPath(); g.moveTo(gx + 8, 15); g.lineTo(gx + 13, 7 + rng() * 2); g.stroke();
      }
    }
    var BG_CLOUD  = { id: "c", factor: 0.08, seed: 101, top: 0,             h: 176, camF: 0,   gen: genCloudTile };
    var BG_MOUNT  = { id: "m", factor: 0.20, seed: 202, top: GROUND_Y - 208, h: 208, camF: 0.3, gen: genMountTile };
    var BG_BAMBOO = { id: "b", factor: 0.50, seed: 303, top: GROUND_Y - 268, h: 268, camF: 0.6, gen: genBambooTile };
    var BG_GROUND = { id: "g", factor: 1.00, seed: 404, top: GROUND_Y - 14,  h: 226, camF: 0,   gen: genGroundTile };
    function getTile(layer, slot, theme) {
      // キャッシュキーはテーマ込み (第12次): 同じスロットの形はテーマ間で
      // 完全一致し、色だけが違うタイルになる (決定的生成は不変)
      var key = layer.id + theme + ":" + slot;
      var c = tileCache.get(key);
      if (c) return c;
      var ts = Math.min(viewScale, 2048 / TILE_W);
      c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(TILE_W * ts));
      c.height = Math.max(1, Math.round(layer.h * ts));
      var g = c.getContext("2d");
      g.scale(ts, ts);
      tilePal = THEMES[theme];
      layer.gen(g, slotRng(layer.seed, slot));
      tileCache.set(key, c);
      if (tileCache.size > 40) { // 可視±1枚を基本に小さく保つ (古いものから破棄)
        var drop = 0;
        tileCache.forEach(function (v, k) { if (drop < 12) { tileCache.delete(k); drop++; } });
      }
      return c;
    }
    /* レイヤーをロール描画する。Y は layer.top の定数 (初期化時に確定した
       レイヤー配置) のみで、毎フレーム再計算しない。カメラ縦追従分は
       snapDev 済みの平行移動として一度だけ合成する */
    function blitLayer(layer, camWorld, camYOff, theme, alpha) {
      if (alpha <= 0) return;
      var cam = camWorld * layer.factor;
      var first = Math.floor((cam + curExtL) / TILE_W);
      ctx.save();
      if (alpha < 1) ctx.globalAlpha = alpha; // テーマ移行中だけ2テーマ目を薄く重ねる (第12次)
      if (layer.camF) ctx.translate(0, snapDev(camYOff * layer.camF));
      for (var n = first; ; n++) {
        var dx = snapDev(n * TILE_W - cam);
        if (dx >= curExtR) break;
        ctx.drawImage(getTile(layer, n, theme), dx, layer.top, TILE_W, layer.h);
      }
      ctx.restore();
    }
    /* 接地影 (視認性パス・第11次): 障害物の足元の柔らかい楕円影 */
    function drawObstacleShadow(cx, w) {
      ctx.beginPath(); ctx.ellipse(cx, GROUND_Y + 7, w * 0.62, 5.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(24,19,11,0.34)"; ctx.fill();
    }
    /* おにぎり (第11次・第14次で約1.35倍に拡大): 白い三角＋黒い海苔。
       一目で分かる輪郭つき。墨玉の大きさは従来どおり変えていない */
    function drawOnigiri(cx, cy) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1.35, 1.35);
      ctx.beginPath();
      ctx.moveTo(0, -17); ctx.lineTo(16, 12); ctx.lineTo(-16, 12); ctx.closePath();
      ctx.fillStyle = "#fffaf0"; ctx.fill();
      ctx.strokeStyle = "#211c14"; ctx.lineWidth = 2.6; ctx.lineJoin = "round"; ctx.stroke();
      ctx.fillStyle = "#211c14";
      ctx.fillRect(-6.5, 1, 13, 11); // 海苔
      ctx.fillStyle = "rgba(33,28,20,0.16)";
      ctx.beginPath(); ctx.arc(-6, -4, 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(5, -8, 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    /* 変わり身アイテム (第12次・第14次で改称＋約1.35倍に拡大): 小さな
       すみ忍の印。頭巾頭＋白い目帯＋点目＋ちび体で、本体と同じ言語の
       シルエットにする。月夜でも読めるよう輪郭は nightF で明るく保つ */
    function drawBunshinItem(cx, cy) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1.35, 1.35);
      var edge = mixHex("#211c14", "#dfe6f5", nightF * 0.8);
      // 体 (小さな台形)
      ctx.beginPath();
      ctx.moveTo(-6, 16); ctx.lineTo(-4, 4); ctx.lineTo(4, 4); ctx.lineTo(6, 16); ctx.closePath();
      ctx.fillStyle = "#211c14"; ctx.fill();
      ctx.strokeStyle = edge; ctx.lineWidth = 1.6; ctx.stroke();
      // 頭 (大きな丸)
      ctx.beginPath(); ctx.arc(0, -4, 10.5, 0, Math.PI * 2);
      ctx.fillStyle = "#211c14"; ctx.fill();
      ctx.strokeStyle = edge; ctx.lineWidth = 1.8; ctx.stroke();
      // 目帯 (白) と点目
      ctx.fillStyle = "#f7f1de";
      ctx.fillRect(-8.5, -8, 17, 5.5);
      ctx.fillStyle = "#211c14";
      ctx.beginPath(); ctx.arc(-3.6, -5.2, 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(3.6, -5.2, 1.5, 0, Math.PI * 2); ctx.fill();
      // 変わり身らしさ: 薄い輪をゆっくり回す
      ctx.beginPath(); ctx.arc(0, 2, 16, visualTime * 1.6, visualTime * 1.6 + Math.PI * 1.2);
      ctx.strokeStyle = "rgba(150,165,200,0.65)"; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.restore();
    }
    /* 火遁アイテム (第14次・仕様D): 炎の巻物。赤い帯の巻物＋上に揺れる
       炎で、他のアイテムと一目で区別できるようにする (拡大対象: 約46px) */
    function drawKatonItem(cx, cy) {
      ctx.save();
      ctx.translate(cx, cy);
      // 巻物 (横長の円筒＋両端の軸)
      ctx.fillStyle = "#f3e7c8";
      ctx.fillRect(-19, -6, 38, 15);
      ctx.strokeStyle = "#211c14"; ctx.lineWidth = 2.4; ctx.strokeRect(-19, -6, 38, 15);
      ctx.fillStyle = "#8a6a3c";
      ctx.fillRect(-23, -8, 5, 19); ctx.fillRect(18, -8, 5, 19);
      ctx.strokeStyle = "#211c14"; ctx.lineWidth = 1.6;
      ctx.strokeRect(-23, -8, 5, 19); ctx.strokeRect(18, -8, 5, 19);
      // 赤い帯と「火」の印
      ctx.fillStyle = "#b3372a"; ctx.fillRect(-4, -6, 8, 15);
      ctx.fillStyle = "#fff8ea"; ctx.font = "900 10px 'Zen Kaku Gothic New', sans-serif"; ctx.textAlign = "center";
      ctx.fillText("火", 0, 6);
      // 上の炎 (ゆらめき)
      var fl = Math.sin(visualTime * 9 + cx * 0.05) * 2;
      ctx.beginPath();
      ctx.moveTo(-6, -8);
      ctx.quadraticCurveTo(-7, -18 + fl * 0.4, 0, -24 + fl);
      ctx.quadraticCurveTo(7, -18 - fl * 0.4, 6, -8);
      ctx.closePath();
      ctx.fillStyle = "#e86a28"; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-3, -8);
      ctx.quadraticCurveTo(-3, -14, 0, -17 + fl * 0.7);
      ctx.quadraticCurveTo(3, -14, 3, -8);
      ctx.closePath();
      ctx.fillStyle = "#f6c453"; ctx.fill();
      ctx.restore();
    }
    /* 水遁アイテム (第25次): 水の巻物。青い帯の巻物＋下に揺れる波の紋で、
       火遁 (赤)・風遁 (緑) と一目で区別できるようにする */
    function drawSuitonItem(cx, cy) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle = "#eef4e6";
      ctx.fillRect(-19, -6, 38, 15);
      ctx.strokeStyle = "#211c14"; ctx.lineWidth = 2.4; ctx.strokeRect(-19, -6, 38, 15);
      ctx.fillStyle = "#5a7a8a";
      ctx.fillRect(-23, -8, 5, 19); ctx.fillRect(18, -8, 5, 19);
      ctx.strokeStyle = "#211c14"; ctx.lineWidth = 1.6;
      ctx.strokeRect(-23, -8, 5, 19); ctx.strokeRect(18, -8, 5, 19);
      // 青い帯と「水」の印
      ctx.fillStyle = "#2a6ea8"; ctx.fillRect(-4, -6, 8, 15);
      ctx.fillStyle = "#fff8ea"; ctx.font = "900 10px 'Zen Kaku Gothic New', sans-serif"; ctx.textAlign = "center";
      ctx.fillText("水", 0, 6);
      // 下の波 (うねり)
      var wv = Math.sin(visualTime * 7 + cx * 0.05) * 1.6;
      ctx.beginPath();
      ctx.moveTo(-13, 14 + wv * 0.4);
      ctx.quadraticCurveTo(-7, 9 + wv, 0, 13 + wv * 0.4);
      ctx.quadraticCurveTo(7, 17 - wv, 13, 12 + wv * 0.4);
      ctx.strokeStyle = "#2a6ea8"; ctx.lineWidth = 2.6; ctx.lineCap = "round"; ctx.stroke();
      ctx.beginPath(); ctx.arc(10, 8 + wv * 0.5, 2.1, 0, Math.PI * 2);
      ctx.fillStyle = "#7ec3e8"; ctx.fill();
      ctx.restore();
    }
    /* 風遁アイテム (第25次): 風の巻物。緑の帯の巻物＋上に回る渦の紋 */
    function drawFuutonItem(cx, cy) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle = "#f0eedd";
      ctx.fillRect(-19, -6, 38, 15);
      ctx.strokeStyle = "#211c14"; ctx.lineWidth = 2.4; ctx.strokeRect(-19, -6, 38, 15);
      ctx.fillStyle = "#7a8a5a";
      ctx.fillRect(-23, -8, 5, 19); ctx.fillRect(18, -8, 5, 19);
      ctx.strokeStyle = "#211c14"; ctx.lineWidth = 1.6;
      ctx.strokeRect(-23, -8, 5, 19); ctx.strokeRect(18, -8, 5, 19);
      // 緑の帯と「風」の印
      ctx.fillStyle = "#3d7a4a"; ctx.fillRect(-4, -6, 8, 15);
      ctx.fillStyle = "#fff8ea"; ctx.font = "900 10px 'Zen Kaku Gothic New', sans-serif"; ctx.textAlign = "center";
      ctx.fillText("風", 0, 6);
      // 上の渦 (ゆっくり回る)
      ctx.beginPath();
      ctx.arc(0, -15, 6.4, visualTime * 3.2, visualTime * 3.2 + Math.PI * 1.35);
      ctx.strokeStyle = "#3d7a4a"; ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -15, 2.6, visualTime * 3.2 + 2.2, visualTime * 3.2 + 2.2 + Math.PI * 1.2);
      ctx.strokeStyle = "#7ab88a"; ctx.lineWidth = 1.8; ctx.stroke();
      ctx.restore();
    }
    /* 火の玉 (第14次): 周回用・追尾用で共用。橙の外炎＋黄の芯＋小さな尾 */
    function drawFireBall(cx, cy, r) {
      var fl = 0.85 + Math.sin(visualTime * 24 + cx * 0.11 + cy * 0.07) * 0.15;
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, r * fl, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(232,106,40,0.92)"; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.55 * fl, 0, Math.PI * 2);
      ctx.fillStyle = "#f6c453"; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.26, 0, Math.PI * 2);
      ctx.fillStyle = "#fff3cf"; ctx.fill();
      ctx.restore();
    }
    /* 敵忍者 (第14次・仕様F／第15次で拡大): すみ忍と誤認しないための明確な
       差別化 — 赤黒の頭巾、怒り眉の吊り目、痩せ型の体、逆向き (左向き) の
       走行。脚は位相で交互に振る簡易サイクル。地上走行のみ。
       第15次: 実機で「小さすぎ」との指摘を受け、描画を ENEMY_SCALE 倍に
       拡大した。拡大後の身長は約110pxで、自機の本体表示 (約100px) の
       約1.1倍。当たり判定 (w60×h68) は見た目より一回り小さい甘めのまま */
    var ENEMY_SCALE = 2.5;
    function drawEnemy(x, e) {
      var cx = x + e.w / 2;
      var baseY = GROUND_Y - (e.y || 0);
      drawObstacleShadow(cx, e.w + 34);
      var ph = e.runPh || 0;
      var legA = Math.sin(ph) * 7, legB = Math.sin(ph + Math.PI) * 7;
      var bob = Math.abs(Math.sin(ph)) * 2;
      ctx.save();
      ctx.translate(cx, baseY - bob * ENEMY_SCALE);
      ctx.scale(ENEMY_SCALE, ENEMY_SCALE);
      // 脚 (痩せ型: 細く長い)
      ctx.strokeStyle = "#2a1214"; ctx.lineWidth = 4.4; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(-2, -16); ctx.lineTo(-2 + legA, -1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(3, -16); ctx.lineTo(3 + legB, -1); ctx.stroke();
      // 体 (痩せた台形、赤黒の装束)
      ctx.beginPath();
      ctx.moveTo(-6, -2); ctx.lineTo(-5, -20); ctx.lineTo(6, -20); ctx.lineTo(7, -2); ctx.closePath();
      ctx.fillStyle = "#4a1620"; ctx.fill();
      ctx.strokeStyle = "#17090c"; ctx.lineWidth = 1.8; ctx.stroke();
      ctx.fillStyle = "#b3372a"; ctx.fillRect(-5, -13, 11, 3.4); // 赤い帯
      // 腕 (前方へ伸ばす)
      ctx.strokeStyle = "#2a1214"; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(-3, -18); ctx.lineTo(-13, -12 + Math.sin(ph) * 2.4); ctx.stroke();
      // 頭 (赤黒の頭巾、すみ忍の丸頭巾より縦長で尖らせる)
      ctx.beginPath();
      ctx.moveTo(-9, -24);
      ctx.quadraticCurveTo(-10, -40, -2, -43);
      ctx.quadraticCurveTo(7, -44, 9, -36);
      ctx.quadraticCurveTo(10, -28, 7, -24);
      ctx.closePath();
      ctx.fillStyle = "#7c1d24"; ctx.fill();
      ctx.strokeStyle = "#17090c"; ctx.lineWidth = 1.8; ctx.stroke();
      // 頭巾の結び目 (後方＝右へ流れる)
      ctx.beginPath(); ctx.moveTo(8, -38); ctx.quadraticCurveTo(16, -40, 19, -34); ctx.quadraticCurveTo(13, -33, 8, -33); ctx.closePath();
      ctx.fillStyle = "#7c1d24"; ctx.fill();
      // 目帯は付けず、怒り目を直接描く: 吊り上がった白目＋赤い瞳＋怒り眉
      ctx.fillStyle = "#f7f1de";
      ctx.beginPath(); ctx.moveTo(-8, -32); ctx.lineTo(-1, -33.6); ctx.lineTo(-1, -29.4); ctx.lineTo(-8, -29.8); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#d23b2a";
      ctx.beginPath(); ctx.arc(-4.4, -31.2, 1.7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#17090c"; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(-9, -35.4); ctx.lineTo(-0.5, -33.4); ctx.stroke(); // 怒り眉
      ctx.restore();
    }
    /* 変わり身の丸太 (第14次・仕様B): 横倒しの丸太＋年輪。残り時間で
       薄くなり、最後は煙に紛れて消える */
    function drawLog(cx, baseY, a) {
      ctx.save();
      ctx.globalAlpha = clamp(a * 1.4, 0, 1);
      ctx.translate(cx, baseY - 12);
      ctx.fillStyle = "#8a6a44";
      ctx.fillRect(-24, -10, 48, 20);
      ctx.strokeStyle = "#4c3820"; ctx.lineWidth = 2.2; ctx.strokeRect(-24, -10, 48, 20);
      ctx.beginPath(); ctx.moveTo(-24, -3); ctx.lineTo(24, -3); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-24, 4); ctx.lineTo(24, 4); ctx.stroke();
      // 切り口 (左端の年輪)
      ctx.beginPath(); ctx.ellipse(-24, 0, 5.5, 10, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#d9bd8a"; ctx.fill(); ctx.strokeStyle = "#4c3820"; ctx.stroke();
      ctx.beginPath(); ctx.ellipse(-24, 0, 2.6, 5, 0, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(76,56,32,0.7)"; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.restore();
    }
    function drawOrb(x, y) {
      var bob = Math.sin(elapsed * 3 + x * 0.05) * 3;
      ctx.beginPath(); ctx.arc(x, y + bob, 10, 0, Math.PI * 2);
      ctx.fillStyle = mixHex("#211c14", "#cfd6ea", nightF * 0.85); ctx.fill(); // 月夜では墨玉が闇に沈まないよう持ち上げる (第12次)
      ctx.beginPath(); ctx.arc(x - 3, y + bob - 3, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = mixHex("#f7f1de", "#26304a", nightF * 0.7); ctx.fill();
    }
    function drawPlatform(x, topY, w) {
      ctx.fillStyle = darkMode ? "#171310" : "#2c2619";
      ctx.fillRect(x, topY, w, 12);
      ctx.fillStyle = darkMode ? "#3d362c" : "#57492f";
      ctx.fillRect(x, topY, w, 4);
      ctx.fillStyle = darkMode ? "#171310" : "#2c2619";
      ctx.fillRect(x + 12, topY + 12, 8, GROUND_Y - topY - 12);
      ctx.fillRect(x + w - 20, topY + 12, 8, GROUND_Y - topY - 12);
    }
    function drawSpike(x, w, h) {
      // 竹槍 (視認性パス・第11次): 線ではなく細く尖った槍形を塗り＋墨の輪郭で
      // 描く。竹の緑は少し立て、穂先は淡色で鋭く。色だけでなく形で判別できる
      for (var i = 0; i < 3; i++) {
        var bx = x + 6 + i * 12;
        var topY2 = GROUND_Y - h + (i === 1 ? -4 : 0);
        var tipY = topY2 - 6;
        // 竹の軸 (根元が太く先細りの槍形)
        ctx.beginPath();
        ctx.moveTo(bx + 1, GROUND_Y + 2);
        ctx.lineTo(bx + 4.6, topY2 + 2);
        ctx.lineTo(bx + 9.4, topY2 + 2);
        ctx.lineTo(bx + 13, GROUND_Y + 2);
        ctx.closePath();
        ctx.fillStyle = mixHex("#66804c", "#7d915f", nightF * 0.5); ctx.fill();
        ctx.strokeStyle = mixHex("#241f14", "#e9e0c8", nightF * 0.85); ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
        // 竹の節
        ctx.beginPath(); ctx.moveTo(bx + 2.8, GROUND_Y - h * 0.45); ctx.lineTo(bx + 11.2, GROUND_Y - h * 0.45);
        ctx.strokeStyle = "rgba(24,20,12,0.5)"; ctx.lineWidth = 1.6; ctx.stroke();
        // 穂先 (淡い色の鋭い三角)
        ctx.beginPath();
        ctx.moveTo(bx + 4.2, topY2 + 5); ctx.lineTo(bx + 7, tipY); ctx.lineTo(bx + 9.8, topY2 + 5); ctx.closePath();
        ctx.fillStyle = "#f2e6c4"; ctx.fill();
        ctx.strokeStyle = mixHex("#241f14", "#e9e0c8", nightF * 0.85); ctx.lineWidth = 1.6; ctx.stroke();
      }
    }
    function drawRock(x, baseY, w, h) {
      ctx.beginPath();
      ctx.moveTo(x, baseY);
      ctx.lineTo(x + 5, baseY - h + 8);
      ctx.lineTo(x + w * 0.42, baseY - h);
      ctx.lineTo(x + w - 4, baseY - h + 12);
      ctx.lineTo(x + w, baseY);
      ctx.closePath();
      ctx.fillStyle = mixHex("#6e675c", "#8d94a8", nightF * 0.6); ctx.fill(); // 視認性パス: 岩は一段濃いグレー (月夜では少し持ち上げる)
      ctx.strokeStyle = mixHex("#211c14", "#e9e0c8", nightF * 0.85); ctx.lineWidth = 3.5; ctx.stroke(); // 墨絵風の太い輪郭 (月夜では明るい縁で保つ・第12次)
      ctx.beginPath(); ctx.moveTo(x + w * 0.4, baseY - h + 8); ctx.lineTo(x + w * 0.52, baseY - 10); ctx.stroke();
    }
    function drawCrate(x, topY, w, h) {
      ctx.fillStyle = "#9a7b52"; ctx.fillRect(x, topY, w, h);
      // 木目 (視認性パス・第11次): 横の浅い線で木の質感を足す
      ctx.strokeStyle = "rgba(95,71,38,0.55)"; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(x + 4, topY + h * 0.34); ctx.lineTo(x + w - 4, topY + h * 0.34); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + 4, topY + h * 0.68); ctx.lineTo(x + w - 4, topY + h * 0.68); ctx.stroke();
      // 濃い縁取り (太い輪郭) ＋対角の brace (月夜では縁を少し明るく保つ・第12次)
      ctx.strokeStyle = mixHex("#453114", "#c9b489", nightF * 0.65); ctx.lineWidth = 4; ctx.strokeRect(x + 2, topY + 2, w - 4, h - 4);
      ctx.strokeStyle = "#5f4726"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, topY); ctx.lineTo(x + w, topY + h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + w, topY); ctx.lineTo(x, topY + h); ctx.stroke();
      // 上面は乗れることを示す濃い縁
      ctx.fillStyle = "#6e5636"; ctx.fillRect(x, topY, w, 5);
    }
    function drawFallrock(e, x) {
      if (e.state === "idle") return;
      var cx = x + 23;
      if (e.state === "prewarn" || e.state === "warn") {
        // 予告: 着地点の影 + 警告マーク (テレグラフ)。第23次: prewarn 中は
        // 影を画面右端 (中心 ≤ W-24) に先行表示し、実位置が画面に入り次第
        // 実位置へ移す (高速帯でも着地の0.3秒以上前に影が見えるための措置)。
        // warn 中も同じクランプでつなぎ、影が画面から消える瞬間を作らない
        var dcx = Math.min(cx, W - 24);
        var grow, alpha;
        if (e.state === "prewarn") {
          var pg = 1 - e.timer / (e.preDur || 0.3);
          grow = pg * 0.45; alpha = 0.22 + pg * 0.18; // 右端の先行影は淡く出す
        } else {
          grow = 0.45 + (1 - e.timer / (e.warnDur || 0.3)) * 0.55;
          alpha = 0.40 + (1 - e.timer / (e.warnDur || 0.3)) * 0.35;
        }
        ctx.beginPath(); ctx.ellipse(dcx, GROUND_Y + 8, 14 + grow * 22, 6 + grow * 3, 0, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(33,28,20," + alpha + ")"; ctx.fill();
        var blink = Math.sin(elapsed * 26) > -0.2;
        if (blink) {
          ctx.beginPath(); ctx.arc(dcx, GROUND_Y - 330, 15, 0, Math.PI * 2);
          ctx.fillStyle = "#b3372a"; ctx.fill();
          ctx.fillStyle = "#fff8ea"; ctx.font = "900 20px sans-serif"; ctx.textAlign = "center";
          ctx.fillText("!", dcx, GROUND_Y - 323);
        }
        return;
      }
      var topY;
      if (e.state === "fall" || e.state === "fallpit") topY = GROUND_Y - 330 + e.dy;
      else topY = GROUND_Y - e.h; // landed (第15次: 通常の落下岩に転がりは無い)
      drawRock(x, topY + e.h, e.w, e.h);
      if (e.state === "landed") drawObstacleShadow(cx, e.w);
      if (e.state === "fall") {
        ctx.beginPath(); ctx.ellipse(cx, GROUND_Y + 8, 26, 6, 0, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(33,28,20,0.5)"; ctx.fill();
      }
    }

    function drawFeintrock(e, x) {
      // フェイント落下岩 (第24次で通常方式に統一): 通常の落下岩と違い、
      // 待機中から上空に岩が見えている。予告は通常岩と同じテレグラフ影
      // (prewarn は画面右端に先行表示し、実位置が画面に入り次第 実位置へ
      // 移す) で、warn 中は岩本体が小刻みに揺れる (演出)。落下点は固定
      var cx = x + 23;
      if (e.state === "idle") {
        ctx.beginPath(); ctx.ellipse(cx, GROUND_Y + 8, 14, 5, 0, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(33,28,20,0.18)"; ctx.fill();
        drawRock(x, GROUND_Y - 330 + e.h, e.w, e.h);
        return;
      }
      if (e.state === "prewarn" || e.state === "warn") {
        var dcx = Math.min(cx, W - 24);
        var grow, alpha;
        if (e.state === "prewarn") {
          var pg = 1 - e.timer / (e.preDur || 0.3);
          grow = pg * 0.45; alpha = 0.22 + pg * 0.18; // 右端の先行影は淡く出す (通常岩と同じ)
        } else {
          grow = 0.45 + (1 - e.timer / (e.warnDur || 0.3)) * 0.55;
          alpha = 0.40 + (1 - e.timer / (e.warnDur || 0.3)) * 0.35;
        }
        ctx.beginPath(); ctx.ellipse(dcx, GROUND_Y + 8, 14 + grow * 22, 6 + grow * 3, 0, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(33,28,20," + alpha + ")"; ctx.fill();
        var jx = e.state === "warn" ? Math.sin(elapsed * 55) * 3 : 0; // warn 中は小刻みに揺れる
        drawRock(x + jx, GROUND_Y - 330 + e.h, e.w, e.h);
        if (Math.sin(elapsed * 26) > -0.2) {
          ctx.beginPath(); ctx.arc(dcx, GROUND_Y - 330, 15, 0, Math.PI * 2);
          ctx.fillStyle = "#b3372a"; ctx.fill();
          ctx.fillStyle = "#fff8ea"; ctx.font = "900 20px sans-serif"; ctx.textAlign = "center";
          ctx.fillText("!", dcx, GROUND_Y - 323);
        }
        return;
      }
      var topY;
      if (e.state === "fall" || e.state === "fallpit") topY = GROUND_Y - 330 + e.dy;
      else topY = GROUND_Y - e.h; // landed (転がりは廃止したので着地後は静止)
      drawRock(x, topY + e.h, e.w, e.h);
      if (e.state === "landed") drawObstacleShadow(cx, e.w);
      if (e.state === "fall") {
        ctx.beginPath(); ctx.ellipse(cx, GROUND_Y + 8, 26, 6, 0, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(33,28,20,0.5)"; ctx.fill();
      }
    }

    /* ---------------- スプライト (画像方式) ----------------
       走行: 生成動画から切り出した8フレーム (frun1-8、全フレーム共通キャンバス
       372×512)。承認済みスプライトを起点に生成した走行動画の1サイクルを透過PNG化
       したもので、足全体＋最下点の下の透明余白を含む (旧 vrun は足が画像下端で
       切れていたため差し替え)。フレーム内に体の上下動と脚・腕の動きが描画済み
       なので、走行には顔基準の
       位置合わせ・追加のボブ・スカッシュ・クロスフェードを一切かけず、
       ハードカットで切り替える (静止画を並べた旧方式は「固定キャラが動いてるだけ」
       に見えたため廃止)。再生周期は速度連動で、1サイクルの総時間は従来程度。
       ジャンプ/ドロン: 静止画スプライト。第10次で素材を走行と同じ
       372×512キャンバス・同じ中身比率に作り直し、描画も走行と同じ
       描画高さ (RUN_H) に統一した (ジャンプ=基準線アンカー、ドロン=
       目の位置アンカー)。旧素材前提の目帯基準オフセット (FACE_UP等) は廃止。
       同一性は Kanta提供の参照画像と原画照合済み:
       巨大な丸い黒頭巾頭 / 白い横長の目帯に黒い点目2つ / 下半分は黒マスク /
       ちび体型の黒装束+帯 / 丸いこぶし / 短い脚 / 横に流れる頭巾の結び目 / 無表情。
       当たり判定・物理・チャンク生成は従来どおりで、ここは描画だけを担う。 */
    /* 表示高さは全状態で RUN_H に統一 (第10次)。状態別の描画高さ定数は廃止 */
    var SPRITES = {};
    (function () {
      var defs = {
        frun1: "assets/suminin-frun1.png",
        frun2: "assets/suminin-frun2.png",
        frun3: "assets/suminin-frun3.png",
        frun4: "assets/suminin-frun4.png",
        frun5: "assets/suminin-frun5.png",
        frun6: "assets/suminin-frun6.png",
        frun7: "assets/suminin-frun7.png",
        frun8: "assets/suminin-frun8.png",
        jump: "assets/suminin-jump.png",
        dash: "assets/suminin-dash.png"
      };
      for (var k in defs) { var im = new Image(); im.src = defs[k]; SPRITES[k] = im; }
    })();
    /* 目の位置 (両瞳の中点) の相対座標 (新素材の画像実測, 0..1)。
       走行はフレームごとに上下動するため8フレーム平均を使う。
       ドロンのアンカー専用: ドロン素材の目の位置が、走行の目の位置
       (足元基準点から見た相対位置) と一致するよう画像を置く。
       ジャンプは最低点が走行と同じ基準線 (89.7%) に揃えてあるため、
       走行と同じ基準線アンカーで描く (目の補正は不要) */
    var EYE_RUN = { x: 0.754, y: 0.326 };  // 走行8フレームの瞳中心平均 (yは0.310–0.341の平均)
    var EYE_DASH = { x: 0.766, y: 0.359 }; // ドロン素材の瞳中心
    /* 走行サイクル: 生成動画から切り出した8フレーム (frun1→8) をこの順でループ。
       全フレーム共通キャンバス 372×512・同一原点で、上下動と脚の動きはフレーム内に描画済み */
    var RUN_CYCLE = ["frun1", "frun2", "frun3", "frun4", "frun5", "frun6", "frun7", "frun8"];
    /* 走行素材の framing 基準 (Phase 4): キャラ本体は画像高の約86.3%で、接地基準線
       (最下点) は上から89.7%の位置。描画高さは 本体表示 / 0.863 で決め、画像下端
       ではなく基準線を GROUND_Y に一致させる (旧方式「画像下端＝地面」は足が
       切れて見えた)。第4次で本体表示を約189→約160論理pxへ縮小し (描画高さ185)、
       第8次で約160→約136論理pxへ再縮小し (描画高さ158)、第9次で約136→約100論理pxへ
       再縮小したため、描画高さは 100 / 0.863 ≒ 116 論理px (基準線89.7%と GROUND_Y の一致は維持)。
       第10次でジャンプ/ドロン素材も同じ 372×512 キャンバスに統一したため、
       この RUN_H は全状態共通の描画高さになった */
    var RUN_H = 116;
    var RUN_BASELINE = 0.897;
    function spriteReady(im) { return !!(im && im.complete && im.naturalWidth > 0); }
    /* ジャンプ描画: 新素材は最低点が基準線 (89.7%) に一致するため、走行と
       同じ基準線アンカーで描く。スカッシュ (バネ) だけは足元支点の拡縮として
       残す (状態をまたぐ拡縮定数・傾き・速度ストレッチは第10次で廃止し、
       状態切替で大きさが変わって見える要因を除いた) */
    function sprW(im) { return im.naturalWidth || im.width; }
    function sprH(im) { return im.naturalHeight || im.height; }
    function drawJumpFrame(im, cx, baseY, sx, sy) {
      if (!spriteReady(im)) return;
      var src = getTinted(im); // 墨の濃さ (第11次): 色変換済み画像 (真っ黒時は元画像)
      var dh = RUN_H;
      var dw = dh * sprW(src) / sprH(src);
      ctx.save();
      ctx.translate(cx, baseY); ctx.scale(sx, sy); ctx.translate(-cx, -baseY);
      ctx.drawImage(src, cx - dw / 2, baseY - RUN_BASELINE * dh, dw, dh);
      ctx.restore();
    }

    /* ドロン描画: 浮いたポーズで最低点が基準線に無いため、基準線ではなく
       目の位置でアンカーする。ドロンの瞳中心が、走行の瞳中心 (足元基準点
       からの相対位置) と同じ画面位置に来るよう画像を置く。描画高さは
       走行と同じ RUN_H (旧仕様の 1.03 倍拡縮は廃止) */
    function drawDashFrame(im, cx, baseY, alpha) {
      if (!spriteReady(im)) return;
      var src = getTinted(im);
      var dh = RUN_H;
      var dw = dh * sprW(src) / sprH(src);
      var eyeX = cx + (EYE_RUN.x - 0.5) * dw;              // 走行時の瞳中心の画面位置
      var eyeY = baseY - (RUN_BASELINE - EYE_RUN.y) * dh;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(src, eyeX - EYE_DASH.x * dw, eyeY - EYE_DASH.y * dh, dw, dh);
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    /* 走行フレーム描画: 共通キャンバス・同一原点の動画フレームを、接地基準線
       (画像高の89.7%の行) が足元基準点に一致するよう描く。基準線は全フレーム
       共通の固定値なので、フレーム毎の最下点の違い (=走行の上下動・脚の離地) は
       そのまま絵として出る。位置合わせ・傾き・拡縮・フェードは一切かけない */
    function drawRunFrame(im, cx, baseY) {
      if (!spriteReady(im)) return;
      var src = getTinted(im);
      var dh = RUN_H;
      var dw = dh * sprW(src) / sprH(src);
      ctx.drawImage(src, cx - dw / 2, baseY - RUN_BASELINE * dh, dw, dh);
    }

    /* ---- ドロン残像: dashスプライトを半透明で ---- */
    function drawGhost(gx, gy, alpha) {
      drawDashFrame(SPRITES.dash, gx, gy, alpha);
    }

    /* 水遁の波 (第25次): 自機の足元を中心に前後へ広がる大波。本体は
       うねる曲線で塗り、波頭には白い泡の粒を散らす */
    function drawWave(x, groundY) {
      var t = visualTime;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x - 105, groundY + 2);
      ctx.quadraticCurveTo(x - 78, groundY - 16 - Math.sin(t * 6.1) * 3, x - 52, groundY - 24 - Math.sin(t * 7.3 + 1) * 3);
      ctx.quadraticCurveTo(x - 26, groundY - 33 - Math.sin(t * 8.2 + 2) * 3, x, groundY - 28 - Math.sin(t * 6.7 + 3) * 3);
      ctx.quadraticCurveTo(x + 28, groundY - 34 - Math.sin(t * 7.8 + 4) * 3, x + 54, groundY - 22 - Math.sin(t * 6.4 + 5) * 3);
      ctx.quadraticCurveTo(x + 76, groundY - 12, x + 88, groundY + 2);
      ctx.closePath();
      var wg = ctx.createLinearGradient(0, groundY - 36, 0, groundY + 2);
      wg.addColorStop(0, "rgba(110,180,228,0.95)");
      wg.addColorStop(1, "rgba(38,102,168,0.95)");
      ctx.fillStyle = wg;
      ctx.fill();
      ctx.strokeStyle = "rgba(230,246,255,0.85)"; ctx.lineWidth = 2.2; ctx.stroke();
      // 波頭の泡
      ctx.fillStyle = "rgba(240,250,255,0.9)";
      for (var bi = 0; bi < 5; bi++) {
        var bx2 = x - 52 + bi * 26 + Math.sin(t * 9 + bi * 2.1) * 3;
        var by2 = groundY - 27 - Math.sin(t * 7 + bi * 1.7) * 4 - (bi % 2) * 4;
        ctx.beginPath(); ctx.arc(bx2, by2, 2.6 + (bi % 3), 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    function drawPlayer(x, baseY, airY) {
      var p = player;
      var dashing = p.dashT > 0;
      var ph = p.runPhase;

      /* 水遁の波 (第25次): 波乗り中は波を足元 (地面ライン) に描き、接地中は
         波頭の高さだけ本体を持ち上げて「波の上に立つ」姿にする。ジャンプで
         波を離れた間は持ち上げず、波だけが下を進む */
      var riding = suitonOn() && state === "playing";
      var wLift = (riding && p.grounded) ? 27 : 0;
      if (riding) drawWave(x, baseY + airY);
      baseY -= wLift;

      /* 残像 (ドロン中のみ) */
      for (var gi = 0; gi < ghostTrail.length; gi++) {
        var g = ghostTrail[gi];
        var gx = x - (scroll - g.scroll) - (p.dashOff - g.off);
        if (gx < x - 190) continue;
        drawGhost(gx, GROUND_Y - g.y, 0.30 * (g.life / g.maxLife) * pitAlpha);
      }

      /* 月夜の月明かり (第12次): 暗い帯でも黒いキャラが景色に沈まないよう、
         背後に淡い光をにじませる (色だけの配慮で、判定・濃さには無関係) */
      if (nightF > 0.02 && pitAlpha > 0) {
        var mR = 78;
        var mGrd = ctx.createRadialGradient(x, baseY - 48, 8, x, baseY - 48, mR);
        mGrd.addColorStop(0, "rgba(205,216,248," + (0.20 * nightF * pitAlpha).toFixed(3) + ")");
        mGrd.addColorStop(1, "rgba(205,216,248,0)");
        ctx.fillStyle = mGrd;
        ctx.beginPath(); ctx.arc(x, baseY - 48, mR, 0, Math.PI * 2); ctx.fill();
      }

      /* 墨のオーラ (第11次・段階2): 真っ黒になった後、墨玉を取るごとに
         背後ににじむ放射グラデーションが広がる (描画はグラデーション1回) */
      var aT = auraT();
      if (aT > 0 && pitAlpha > 0) {
        var aPulse = 1 + Math.sin(visualTime * 1.9) * 0.09;
        var aR = (30 + 68 * aT) * aPulse;
        var aCx = x, aCy = baseY - 48;
        var aA = (0.10 + 0.26 * aT) * pitAlpha;
        var grd = ctx.createRadialGradient(aCx, aCy, aR * 0.12, aCx, aCy, aR);
        grd.addColorStop(0, "rgba(33,28,20," + aA.toFixed(3) + ")");
        grd.addColorStop(0.55, "rgba(33,28,20," + (aA * 0.45).toFixed(3) + ")");
        grd.addColorStop(1, "rgba(33,28,20,0)");
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(aCx, aCy, aR, 0, Math.PI * 2); ctx.fill();
      }

      /* 変わり身の分身の追走 (第12次): ストック中は小さく (約62%) 半透明で
         後ろを付いて走る。本体と同じ素材・同じ墨の濃さで、位相だけ少し遅らせる */
      if (bunshinStock > 0 && state === "playing" && pitAlpha > 0) {
        var bx = x - 58;
        ctx.save();
        ctx.globalAlpha = 0.55 * pitAlpha;
        ctx.translate(bx, baseY); ctx.scale(0.62, 0.62); ctx.translate(-bx, -baseY);
        if (dashing) drawDashFrame(SPRITES.dash, bx, baseY, 0.55 * pitAlpha);
        else if (!p.grounded) drawJumpFrame(SPRITES.jump, bx, baseY, 1, 1);
        else {
          var bf2 = (ph - 0.9) / (Math.PI / 2);
          var bIdx = ((Math.floor(bf2) % 8) + 8) % 8;
          drawRunFrame(SPRITES[RUN_CYCLE[bIdx]], bx, baseY);
        }
        ctx.restore();
      }

      /* 影 (接地感のため残す) */
      var shScale = clamp(1 - airY / 360, 0.28, 1);
      ctx.beginPath(); ctx.ellipse(x, baseY + wLift + airY + 8, 25 * shScale, 5 * shScale, 0, 0, Math.PI * 2); // 影もキャラ縮小に比例 (第9次: 34×7→25×5)。波乗り中も影は地面に置く (第25次: wLift を戻す)
      ctx.fillStyle = "rgba(33,28,20," + (0.32 * pitAlpha).toFixed(3) + ")"; ctx.fill();

      /* 変わり身の直後 (第14次): 本体は短くちらついて「現れた」感を出す */
      var blinkA = (kawarimiT > 0 && state === "playing") ? (Math.sin(visualTime * 42) > -0.2 ? 0.3 : 1) : 1;
      if (!p.grounded && !dashing) {
        /* 空中: ジャンプ素材を走行と同じ基準線アンカー・同じ描画高さで描く。
           残す変形はバネのスカッシュだけ (傾きと速度ストレッチは廃止) */
        var sq = p.squash;
        var sx = 1 + sq * 0.05, sy = 1 - sq * 0.055;
        ctx.save(); ctx.globalAlpha = pitAlpha * blinkA;
        drawJumpFrame(SPRITES.jump, x, baseY, sx, sy);
        ctx.restore();
      } else if (dashing) {
        /* ドロン: 目の位置アンカー・描画高さは走行と同じ (拡縮なし) */
        drawDashFrame(SPRITES.dash, x, baseY, pitAlpha * blinkA);
      } else {
        /* 地上走行: 動画切り出し8フレームをハードカットで切替。
           1サイクル = 位相4π (総時間は従来どおり)、1フレーム = π/2。
           上下動はフレーム内に描画済みなのでボブ等は足さない */
        var f = ph / (Math.PI / 2);
        var idx = ((Math.floor(f) % 8) + 8) % 8;
        ctx.save(); ctx.globalAlpha = pitAlpha * blinkA;
        drawRunFrame(SPRITES[RUN_CYCLE[idx]], x, baseY);
        ctx.restore();
      }

      /* 火遁の火の玉 (第14次・仕様D): 残数がそのまま周回する玉の数になる。
         玉はキャラの周囲を回り、発射されると1つずつ減っていく */
      if (katonBalls > 0 && state === "playing" && pitAlpha > 0) {
        for (var fb = 0; fb < katonBalls; fb++) {
          var fa = visualTime * 2.6 + fb * (Math.PI * 2 / 5);
          var fx2 = x + Math.cos(fa) * 47;
          var fy2 = baseY - 50 + Math.sin(fa) * 34;
          drawFireBall(fx2, fy2, 8);
        }
      }

      /* 無敵エフェクト (第11次・おにぎり): 金の縁取り＋回る墨の輪。
         終了1秒前からは点滅して予告する */
      if (invincibleT > 0 && state === "playing") {
        var blinkOff = invincibleT < 1 && Math.sin(visualTime * 26) > 0.2;
        if (!blinkOff) {
          var iPulse = 1 + Math.sin(visualTime * 6) * 0.05;
          ctx.save();
          ctx.beginPath(); ctx.ellipse(x, baseY - 48, 52 * iPulse, 58 * iPulse, 0, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(232,182,76,0.9)"; ctx.lineWidth = 2.6; ctx.stroke();
          ctx.beginPath(); ctx.ellipse(x, baseY - 48, 58 * iPulse, 64 * iPulse, 0, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(232,182,76,0.32)"; ctx.lineWidth = 5; ctx.stroke();
          ctx.beginPath(); ctx.arc(x, baseY - 48, 63 * iPulse, visualTime * 2.2, visualTime * 2.2 + Math.PI * 1.3);
          ctx.strokeStyle = "rgba(33,28,20,0.55)"; ctx.lineWidth = 2; ctx.stroke();
          ctx.restore();
        }
      }

      /* ダッシュ可能表示 */
      if (state === "playing" && player.dashCd <= 0) {
        ctx.beginPath(); ctx.arc(x + 43, baseY - 95, 5, 0, Math.PI * 2); // 位置はキャラ縮小に比例 (第9次: +58/-129→+43/-95)
        ctx.fillStyle = "rgba(179,55,42,0.85)"; ctx.fill();
      }

      /* ニアミス吹き出し (第12次): 頭上の右上に小さな「……」を約0.6秒、
         最後はフェードで消す。顔 (中央) は隠さない位置と大きさにする */
      if (bubbleT > 0 && state === "playing" && pitAlpha > 0) {
        var bubA = clamp(bubbleT / 0.22, 0, 1) * pitAlpha;
        var bubX = x + 36, bubY = baseY - 116;
        ctx.save();
        ctx.globalAlpha = bubA;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bubX - 19, bubY - 11, 38, 21, 8); else ctx.rect(bubX - 19, bubY - 11, 38, 21);
        ctx.fillStyle = "rgba(255,250,240,0.94)"; ctx.fill();
        ctx.strokeStyle = "rgba(33,28,20,0.65)"; ctx.lineWidth = 1.4; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bubX - 12, bubY + 9); ctx.lineTo(bubX - 4, bubY + 9); ctx.lineTo(bubX - 10, bubY + 16); ctx.closePath();
        ctx.fillStyle = "rgba(255,250,240,0.94)"; ctx.fill();
        ctx.fillStyle = "#211c14";
        ctx.font = "900 11px 'Zen Kaku Gothic New', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("……", bubX, bubY + 4);
        ctx.restore();
      }
    }

    /* ---------------- メインループ ----------------
       固定ステップ + 補間 [Gaffer]。ヒットストップ中は時間供給を止める。 */
    var lastTs = 0, accumulator = 0, hudTimer = 0;
    var el = {
      dist: document.getElementById("hudDist"), score: document.getElementById("hudScore"),
      mult: document.getElementById("hudMult"), near: document.getElementById("hudNear"),
      speed: document.getElementById("hudSpeed"), t: document.getElementById("hudT"),
      fill: document.getElementById("dashFill"), gauge: document.getElementById("dashGauge"),
      chunk: document.getElementById("chunkInfo"),
      ovTitle: document.getElementById("ovTitle"), ovOver: document.getElementById("ovOver"),
      ovPause: document.getElementById("ovPause"), btnMain: document.getElementById("btnMain")
    };

    function frame(ts) {
      requestAnimationFrame(frame);
      if (!lastTs) lastTs = ts;
      var frameTime = (ts - lastTs) / 1000;
      lastTs = ts;
      // 適応DPR用の負荷計測 (Phase 3): プレイ中だけ移動平均を取り、
      // 悪化が続いたら次回開始時／終了時にだけ上限を一段下げる
      frameEma = frameEma * 0.95 + Math.min(frameTime, 0.05) * 0.05;
      if (state === "playing") {
        if (frameEma > 0.019) slowAcc += frameTime; else slowAcc = Math.max(0, slowAcc - frameTime);
        if (slowAcc > 2 && adaptDprCap > 2) { adaptDprCap -= 0.5; slowAcc = 0; dprDirty = true; }
      }
      visualTime += Math.min(frameTime, 0.05);
      if (state === "title" || state === "over") player.runPhase += frameTime * 11.5;
      if (frameTime > 0.25) frameTime = 0.25; // Gafferのクランプ例

      if (state === "playing" || state === "dying" || state === "pitfall") {
        if (hitstop > 0 && state !== "pitfall") {
          hitstop -= frameTime;
        } else {
          var ft = frameTime * (state === "dying" ? timeScale : 1);
          accumulator += ft;
          var steps = 0;
          while (accumulator >= STEP && steps < 5) {
            if (state === "playing") step(STEP);
            else if (state === "pitfall") stepPit(STEP);
            else { // dying: 落下だけ進める
              prevScroll = scroll; scroll += speed * 0.3 * STEP;
              trauma = Math.max(0, trauma - 1.4 * STEP);
              shakeT += STEP;
            }
            accumulator -= STEP; steps++;
            if (state !== "playing" && state !== "dying" && state !== "pitfall") break;
          }
          if (steps === 5) accumulator = 0; // spiral of death 回避
        }
        if (state === "dying") {
          slowTimer -= frameTime;
          if (slowTimer <= 0) showGameOver();
        }
      }
      var alpha = state === "playing" || state === "dying" || state === "pitfall" ? clamp(accumulator / STEP, 0, 1) : 1;
      var iScroll = lerp(prevScroll, scroll, alpha);
      var iY = lerp(player.prevY, player.y, alpha);
      var iCam = lerp(prevCamY, camY, alpha);
      draw(iScroll, iY, iCam);

      hudTimer -= frameTime;
      if (hudTimer <= 0) { hudTimer = 0.1; updateHud(); }
    }

    function updateHud() {
      var dist = Math.floor(scroll / PX_PER_M);
      el.dist.textContent = dist;
      el.score.textContent = Math.floor(score);
      el.mult.textContent = "×" + mult.toFixed(1);
      el.near.textContent = nearCount;
      el.speed.textContent = Math.round(speed);
      var T = VIEW_AHEAD / Math.max(1, speed);
      el.t.textContent = T.toFixed(2) + "s";
      el.t.className = "num tval " + (T > 0.9 ? "ok" : (T > 0.6 ? "warn" : "danger"));
      var frac = player.dashCd > 0 ? 1 - player.dashCd / DASH_CD : 1;
      el.fill.style.transform = "scaleX(" + clamp(frac, 0, 1) + ")";
      el.gauge.classList.toggle("ready", frac >= 1);
      btnDash.disabled = state !== "playing";
      var inkFillEl = document.getElementById("inkFill"), inkLabelEl = document.getElementById("inkLabel");
      if (inkFillEl && inkLabelEl) {
        if (orbCount < 200) {
          var it2 = inkT();
          inkLabelEl.textContent = "墨 " + orbCount + "／200";
          inkFillEl.style.transform = "scaleX(" + clamp(it2, 0, 1) + ")";
          inkFillEl.style.background = "rgb(" + Math.round(168 + (33 - 168) * it2) + "," + Math.round(163 + (28 - 163) * it2) + "," + Math.round(150 + (20 - 150) * it2) + ")";
        } else {
          inkLabelEl.textContent = "墨 真っ黒・オーラ " + Math.round(auraT() * 100) + "%";
          inkFillEl.style.transform = "scaleX(" + clamp(auraT(), 0, 1) + ")";
          inkFillEl.style.background = "#211c14";
        }
      }
      var invEl = document.getElementById("invGauge");
      if (invEl) {
        if (invincibleT > 0 && state === "playing") {
          invEl.style.visibility = "visible";
          var invLabelEl = document.getElementById("invLabel"), invFillEl = document.getElementById("invFill");
          if (invLabelEl) invLabelEl.textContent = "無敵 " + invincibleT.toFixed(1) + "秒";
          if (invFillEl) invFillEl.style.transform = "scaleX(" + clamp(invincibleT / 5, 0, 1) + ")";
        } else invEl.style.visibility = "hidden";
      }
      // 波乗り (第25次): 波乗り中だけ残り距離ゲージを出す
      var waveEl = document.getElementById("waveGauge");
      if (waveEl) {
        if (suitonOn() && state === "playing") {
          waveEl.style.visibility = "visible";
          var waveLabelEl = document.getElementById("waveLabel"), waveFillEl = document.getElementById("waveFill");
          var waveRemainM = Math.max(0, (suitonEndX - scroll) / PX_PER_M);
          if (waveLabelEl) waveLabelEl.textContent = "波乗り あと" + waveRemainM.toFixed(0) + "m";
          if (waveFillEl) waveFillEl.style.transform = "scaleX(" + clamp(waveRemainM / WAVE_M, 0, 1) + ")";
        } else waveEl.style.visibility = "hidden";
      }
      // 巻物チャレンジの進捗 (第12次): 左上に小さく常時表示
      var missionLabelEl = document.getElementById("missionLabel");
      if (missionLabelEl && mission) {
        if (mission.done) missionLabelEl.innerHTML = "<span class=\"done\">巻物 達成！（+300）</span>";
        else missionLabelEl.textContent = "巻物 " + missionShort(mission) + " " + Math.min(missionProgress(), mission.target) + "／" + mission.target + missionUnit(mission);
      }
      // 変わり身ストック表示 (第12次): 所持中だけ出す
      var bunEl = document.getElementById("bunshinGauge");
      if (bunEl) bunEl.style.visibility = (bunshinStock > 0 && state === "playing") ? "visible" : "hidden";
      el.chunk.textContent = state === "playing" && curChunkName
        ? "現在の地形: " + curChunkName + (curChunkDiff ? "（難度" + curChunkDiff + "）" : "（休息）") : "";
      var oa = document.getElementById("orbAuditLine");
      if (oa && orbAuditCounts.total) {
        oa.textContent = "墨玉の到達検証（自動・生成時に実施）: これまで " + orbAuditCounts.total +
          " 個を検証し、到達可能 " + orbAuditCounts.ok + " 個／到達範囲内へ自動調整 " + orbAuditCounts.relocated +
          " 個／調整後も未達 " + orbAuditCounts.failed + " 個。全件の判定（チャンク名・許容フレーム数つき）はコンソールの window.__orbAudit に残してある。";
      }
      var fa = document.getElementById("fallAuditLine");
      if (fa && fallAuditCounts.total) {
        fa.textContent = "落下岩の着地点検証（自動・生成時に実施）: これまで " + fallAuditCounts.total +
          " 個を検証し、着地可能 " + fallAuditCounts.ok + " 個（うち位置を調整 " + fallAuditCounts.moved +
          " 個）／検証を通らず配置しなかった " + fallAuditCounts.removed +
          " 個。全件の判定はコンソールの window.__fallAudit に残してある。";
      }
      var ca = document.getElementById("chunkAuditLine");
      if (ca && CHUNK_AUDIT.length) {
        var cs = chunkAuditStats();
        ca.textContent = "コース選出の計測（自動・生成時に実施）: このランで " + cs.picks +
          " チャンクを選出。同一チャンクの再出現間隔は平均 " + cs.repeatMean + " チャンク／中央値 " + cs.repeatMedian +
          " チャンク、モード適合率は " + (cs.modeFit === null ? "—" : cs.modeFit + "%") +
          "。全件の選出系列（チャンク名・モード・tier）はコンソールの window.__chunkAudit に残してある。";
      }
      var ta = document.getElementById("trapAuditLine");
      if (ta && trapAuditCounts.chunks) {
        ta.textContent = "トラップ検証（自動・生成時に実施）: これまで " + trapAuditCounts.chunks +
          " 件のトラップチャンクを検証し、安全ルート保証 " + trapAuditCounts.safe +
          " 件（うち通常ジャンプのみで通過可能 " + trapAuditCounts.safeJumpOnly +
          " 件）／保証できず無効化 " + trapAuditCounts.rejected +
          " 件／罠アイテムは " + trapAuditCounts.baitTotal + " 個中 " + trapAuditCounts.baitOk +
          " 個が「取れるが危険」として成立。全件の判定はコンソールの window.__trapAudit に残してある。";
      }
    }

    /* ---------------- 画面遷移 ---------------- */
    function fmtSeed(s) { return "シード #" + s; }
    function startRun(s) {
      AudioSys.init();
      if (state === "over" || state === "title") noteRestart(); // プレイ計測 (P0): 死亡後の再挑戦 = リスタートとして記録 (第20次: オープニング経由の再開始も含む。noteRestart は未死亡時は無動作)
      if (dprDirty) { dprDirty = false; fitCanvas(); } // 適応DPRは境界でのみ適用
      reset(s);
      state = "playing";
      stageEl.classList.add("in-game");
      el.ovTitle.hidden = true; el.ovOver.hidden = true; el.ovPause.hidden = true;
      var ovT = document.getElementById("ovTitles"); if (ovT) ovT.hidden = true;
      el.btnMain.textContent = "最初から";
      AudioSys.startBgm();
      updateHud();
      showMissionBanner(); // 巻物チャレンジ (第12次): 開始直後に約2秒提示
    }
    /* ---------------- P0: 死因コメント・称号・プレイ計測 ---------------- */
    // 死因ごとの一言 (淡々と、少し辛辣に)。die() の死因文字列すべてに対応
    var DEATH_COMMENTS = {
      "竹槍に当たった": "忍び足、失敗。",
      "岩に当たった": "岩は避けるもの。",
      "木箱に激突した": "箱に負けた。",
      "落ちてきた岩に当たった": "上も確認。",
      "落とし穴に落ちた": "足元注意。",
      "敵忍者にやられた": "忍び同士、明暗。"
    };
    /* ---------------- 称号 (第19次で大幅拡充／第25次で40種に増強) ----------------
       全40種。レアリティ3段 (0=通常 / 1=レア / 2=無理ゲー級)。
       結果画面に出す称号は「そのランで条件を満たした中で最もレアなもの」
       (同レアリティ内は表の並び順 = 優先順)。条件を満たした称号はすべて
       取得記録に残る (1ランで複数取得あり)。取得記録はプレイ計測とは
       別キーで localStorage に保存する。条件・名前の一覧は設計メモの
       「称号の拡充 (第19次)」行に表で明記。
       メトリクス m: { dist, score, orbs, near, katon, breaks, dash,
                       onigiri, bunshin, enemy, mission, lap, mult, time,
                       suiton, waveKills, waveGaps, fuuton, tornadoKills,
                       tornadoChain, allJutsu, twoJutsu } (第25次で追加) */
    var TITLES = [
      // --- 無理ゲー級 (rarity 2): 通常プレイではほぼ届かない水準 ---
      { id: "densetsu",  name: "伝説の忍",     seal: "伝", rarity: 2, hint: null, test: function (m) { return m.dist >= 5000; } },
      { id: "sumikeshin", name: "墨の化身",    seal: "化", rarity: 2, hint: null, test: function (m) { return m.orbs >= 400; } },
      { id: "sanshu",    name: "三周の走者",   seal: "三", rarity: 2, hint: null, test: function (m) { return m.lap >= 2; } },
      { id: "kamiwaza",  name: "神のすれ違い", seal: "神", rarity: 2, hint: null, test: function (m) { return m.near >= 30; } },
      { id: "onigari",   name: "鬼狩り",       seal: "鬼", rarity: 2, hint: null, test: function (m) { return m.enemy >= 20; } },
      { id: "hanoha",    name: "波の覇者",     seal: "覇", rarity: 2, hint: null, test: function (m) { return m.waveGaps >= 10; } },
      { id: "fuujin",    name: "風神",         seal: "風", rarity: 2, hint: null, test: function (m) { return m.tornadoChain >= 12; } },
      // --- レア (rarity 1) ---
      { id: "fukutsu",   name: "不屈の忍",     seal: "忍", rarity: 1, hint: "1ランで1500m走る",        test: function (m) { return m.dist >= 1500; } },
      { id: "makkuro",   name: "真っ黒",       seal: "黒", rarity: 1, hint: "墨玉を200個集める",        test: function (m) { return m.orbs >= 200; } },
      { id: "shuukai",   name: "二周目の走者", seal: "周", rarity: 1, hint: "2周目（1600m）に到達する", test: function (m) { return m.lap >= 1; } },
      { id: "en",        name: "炎の達人",     seal: "炎", rarity: 1, hint: "火遁で10体排除する",        test: function (m) { return m.katon >= 10; } },
      { id: "hawari",    name: "刃渡り",       seal: "刃", rarity: 1, hint: "ニアミスを15回決める",      test: function (m) { return m.near >= 15; } },
      { id: "hakaiou",   name: "破壊王",       seal: "王", rarity: 1, hint: "障害物を25個壊す",          test: function (m) { return m.breaks >= 25; } },
      { id: "bairitsu",  name: "倍率職人",     seal: "倍", rarity: 1, hint: "倍率×6.0に到達する",        test: function (m) { return m.mult >= 6; } },
      { id: "manten",    name: "万点の忍",     seal: "万", rarity: 1, hint: "スコア10000以上を取る",     test: function (m) { return m.score >= 10000; } },
      { id: "santon",    name: "三遁皆伝",     seal: "皆", rarity: 1, hint: "1ランで火遁・水遁・風遁をすべて使う", test: function (m) { return !!m.allJutsu; } },
      { id: "oonami",    name: "大波の主",     seal: "波", rarity: 1, hint: "波で15個押し流す",          test: function (m) { return m.waveKills >= 15; } },
      { id: "senpuu",    name: "旋風の達人",   seal: "旋", rarity: 1, hint: "竜巻で15個巻き上げる",      test: function (m) { return m.tornadoKills >= 15; } },
      { id: "shippuu",   name: "疾風怒濤",     seal: "疾", rarity: 1, hint: "1ランで3000m走る",          test: function (m) { return m.dist >= 3000; } },
      { id: "kyuudou",   name: "墨の求道者",   seal: "求", rarity: 1, hint: "墨玉を300個集める",        test: function (m) { return m.orbs >= 300; } },
      { id: "kiwami",    name: "忍狩りの極み", seal: "極", rarity: 1, hint: "敵忍者を12体倒す",          test: function (m) { return m.enemy >= 12; } },
      // --- 通常 (rarity 0) ---
      { id: "kamihitoe", name: "紙一重",       seal: "紙", rarity: 0, hint: "ニアミスを8回決める",       test: function (m) { return m.near >= 8; } },
      { id: "katon",     name: "火遁の使い手", seal: "火", rarity: 0, hint: "火遁で4体排除する",         test: function (m) { return m.katon >= 4; } },
      { id: "sumi",      name: "墨集めの達人", seal: "墨", rarity: 0, hint: "墨玉を40個集める",          test: function (m) { return m.orbs >= 40; } },
      { id: "kemuri",    name: "煙の使い手",   seal: "煙", rarity: 0, hint: "ドロンを10回使う",          test: function (m) { return m.dash >= 10; } },
      { id: "kowashiya", name: "壊し屋",       seal: "壊", rarity: 0, hint: "障害物を10個壊す",          test: function (m) { return m.breaks >= 10; } },
      { id: "ninjagari", name: "忍び狩り",     seal: "狩", rarity: 0, hint: "敵忍者を3体倒す",           test: function (m) { return m.enemy >= 3; } },
      { id: "makimono",  name: "巻物の達成者", seal: "巻", rarity: 0, hint: "巻物チャレンジを達成する",  test: function (m) { return !!m.mission; } },
      { id: "migawari",  name: "身代わりの達人", seal: "身", rarity: 0, hint: "変わり身に1回救われる",   test: function (m) { return m.bunshin >= 1; } },
      { id: "hara",      name: "腹ごしらえ",   seal: "米", rarity: 0, hint: "おにぎりを2個取る",         test: function (m) { return m.onigiri >= 2; } },
      { id: "naminori",  name: "波乗り名人",   seal: "乗", rarity: 0, hint: "水遁で2回波に乗る",         test: function (m) { return m.suiton >= 2; } },
      { id: "shibuki",   name: "波しぶき",     seal: "沫", rarity: 0, hint: "波で5個押し流す",           test: function (m) { return m.waveKills >= 5; } },
      { id: "anagoe",    name: "波の穴越え",   seal: "越", rarity: 0, hint: "波乗りで落とし穴を2つ越える", test: function (m) { return m.waveGaps >= 2; } },
      { id: "issen",     name: "竜巻一閃",     seal: "閃", rarity: 0, hint: "竜巻1発で4個巻き上げる",     test: function (m) { return m.tornadoChain >= 4; } },
      { id: "uzumaki",   name: "渦の使い手",   seal: "渦", rarity: 0, hint: "風遁を2回放つ",             test: function (m) { return m.fuuton >= 2; } },
      { id: "makiage",   name: "巻き上げ屋",   seal: "上", rarity: 0, hint: "竜巻で6個巻き上げる",       test: function (m) { return m.tornadoKills >= 6; } },
      { id: "minarai",   name: "遁術見習い",   seal: "徒", rarity: 0, hint: "1ランで遁術を2種使う",       test: function (m) { return !!m.twoJutsu; } },
      { id: "shissou",   name: "疾走者",       seal: "走", rarity: 0, hint: "1ランで800m走る",           test: function (m) { return m.dist >= 800; } },
      { id: "kiwadoi",   name: "際どい忍",     seal: "際", rarity: 0, hint: "ニアミスを4回決める",       test: function (m) { return m.near >= 4; } },
      { id: "shugyou",   name: "修行中",       seal: "修", rarity: 0, hint: "走り切る（いつも手に入る）", test: function () { return true; } }
    ];
    var TITLES_KEY = "suminin-runner-titles-v1"; // 称号の取得記録 (プレイ計測とは別キー)
    var titleDex = (function () {
      try {
        var raw = window.localStorage.getItem(TITLES_KEY);
        if (raw) { var o = JSON.parse(raw); if (o && typeof o === "object") return o; }
      } catch (e) {}
      return {};
    })();
    function saveTitleDex() {
      try { window.localStorage.setItem(TITLES_KEY, JSON.stringify(titleDex)); } catch (e) {}
    }
    function todayStr() {
      var d = new Date();
      function p2(n) { return (n < 10 ? "0" : "") + n; }
      return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
    }
    // そのランのメトリクスから、条件を満たした称号と表示称号 (最レア) を返す
    function evaluateTitles(m) {
      var met = [];
      for (var i = 0; i < TITLES.length; i++) if (TITLES[i].test(m)) met.push(TITLES[i]);
      var display = met[0] || TITLES[TITLES.length - 1];
      for (var j = 1; j < met.length; j++) if (met[j].rarity > display.rarity) display = met[j];
      return { met: met, display: display };
    }
    // 取得記録へ反映し、新規取得分を返す
    function awardTitles(m) {
      var ev = evaluateTitles(m);
      var fresh = [];
      for (var i = 0; i < ev.met.length; i++) {
        var t = ev.met[i];
        if (!titleDex[t.id]) { titleDex[t.id] = todayStr(); fresh.push(t); }
      }
      if (fresh.length) saveTitleDex();
      return { met: ev.met, display: ev.display, fresh: fresh };
    }
    window.__titles = { list: TITLES, dex: titleDex, evaluate: evaluateTitles, award: awardTitles };
    /* 水遁・風遁の検証用フック (第25次): 状態とカウンタの読み出し */
    window.__jutsu = {
      suitonOn: suitonOn,
      state: function () {
        return { suitonEndX: suitonEndX, suitonUses: suitonUses, waveKills: waveKillCount, waveGaps: waveGapCount,
                 fuutonUses: fuutonUses, fuutonKills: fuutonKillCount, fuutonChain: fuutonMaxChain,
                 tornadoes: tornadoes.length, katonPickups: katonPickupCount, enemyKills: enemyKillCount };
      }
    };
    var RARITY_NAMES = ["通常", "レア", "無理ゲー級"];
    function renderTitlesList() {
      var listEl = document.getElementById("titlesList");
      var countEl = document.getElementById("titlesCount");
      if (!listEl) return;
      var got = 0;
      for (var g = 0; g < TITLES.length; g++) if (titleDex[TITLES[g].id]) got++;
      if (countEl) countEl.textContent = "取得 " + got + " / " + TITLES.length;
      var html = "";
      for (var r = 0; r <= 2; r++) {
        html += "<p class=\"tgroup\">― " + RARITY_NAMES[r] + " ―</p>";
        for (var i = 0; i < TITLES.length; i++) {
          var t = TITLES[i];
          if (t.rarity !== r) continue;
          var date = titleDex[t.id];
          var cls = r === 2 ? " muri" : (r === 1 ? " rare" : "");
          if (date) {
            html += "<div class=\"trow\"><span class=\"seal" + cls + "\">" + t.seal + "</span>"
              + "<span class=\"tmain\"><span class=\"tname\">" + t.name + "</span>"
              + "<span class=\"thint\">" + (t.hint || "条件達成") + "</span></span>"
              + "<span class=\"tdate\">" + date + "</span></div>";
          } else if (r === 2) {
            // 無理ゲー級は未取得なら名前も条件も伏せる
            html += "<div class=\"trow locked\"><span class=\"seal\">？</span>"
              + "<span class=\"tmain\"><span class=\"tname\">？？？</span>"
              + "<span class=\"thint\">？？？</span></span></div>";
          } else {
            html += "<div class=\"trow locked\"><span class=\"seal\">？</span>"
              + "<span class=\"tmain\"><span class=\"tname\">？？？</span>"
              + "<span class=\"thint\">" + (t.hint || "") + "</span></span></div>";
          }
        }
      }
      listEl.innerHTML = html;
    }
    /* プレイ計測 (ローカル): ランごとに 生存時間 / ドロン使用 / 火遁の玉発射 /
       死亡後のリスタート有無 を記録し、この端末の localStorage に累計保存する。
       外部送信はしない。保存できない環境 (プライベートモード等) では
       セッション内だけの集計として動作を続ける */
    var STATS_KEY = "suminin-runner-stats-v1";
    var playStats = (function () {
      var zero = { runs: 0, survival: 0, dash: 0, throws: 0, restarts: 0 };
      try {
        var raw = window.localStorage.getItem(STATS_KEY);
        if (raw) {
          var o = JSON.parse(raw);
          if (o && typeof o.runs === "number") {
            return { runs: o.runs || 0, survival: o.survival || 0, dash: o.dash || 0, throws: o.throws || 0, restarts: o.restarts || 0 };
          }
        }
      } catch (e) {}
      return zero;
    })();
    window.__playStats = playStats;
    var pendingRestart = false; // 直前のランが「リスタート待ち」かどうか (メモリ上のみ)
    function saveStats() {
      try { window.localStorage.setItem(STATS_KEY, JSON.stringify(playStats)); } catch (e) {}
    }
    function recordRunStats() {
      playStats.runs++;
      playStats.survival += runTime;
      playStats.dash += dashUseCount;
      playStats.throws += throwCount;
      pendingRestart = true;
      saveStats();
      renderStats();
    }
    function noteRestart() {
      if (!pendingRestart) return;
      pendingRestart = false;
      playStats.restarts++;
      saveStats();
      renderStats();
    }
    function renderStats() {
      var elx = document.getElementById("playStatsLine");
      if (!elx) return;
      if (!playStats.runs) {
        elx.textContent = "プレイ計測（この端末のローカル記録・外部送信なし）: まだ記録がありません。1回遊ぶと、ここに総プレイ数・平均生存時間・ドロン／火遁の使用頻度・リスタート率が集計されます。";
        return;
      }
      var avg = playStats.survival / playStats.runs;
      var dAvg = playStats.dash / playStats.runs;
      var tAvg = playStats.throws / playStats.runs;
      var rate = Math.round(playStats.restarts / playStats.runs * 100);
      elx.textContent = "プレイ計測（この端末のローカル記録・外部送信なし）: 総プレイ数 " + playStats.runs +
        "回／平均生存時間 " + avg.toFixed(1) + "秒／1プレイあたり ドロン " + dAvg.toFixed(1) +
        "回・火遁の玉発射 " + tAvg.toFixed(1) + "回／リスタート率 " + rate +
        "%（死亡後に再挑戦した割合）。記録は localStorage に累計保存され、今後の調整の材料にします。";
    }
    /* ---------------- 墨の濃さシステム (第11次・1ラン内) ----------------
       Kanta決定: 累計ではなく1ラン内の成長とする (無限ランナーなので
       長く走れば届く、やりがいの目標として置く)。保存はしない。
       段階1 (そのラン 0–200個): 進捗 p = 取得数/200 に対し、濃さは
       線形ではなく序盤速めのイーズアウトで立ち上げる (中間の変化が
       弱く感じるという指摘への改修)。曲線は 2次イーズアウト
       1-(1-p)^2 と sqrt(p) のブレンドで、50個 (p=0.25) で約46%、
       100個 (p=0.5) で約74% に達し、200個でちょうど真っ黒 (100%) に
       一致する。開始直後も、1個で色変換キャッシュが1段進み、5個で
       約8%まで濃くなるので変化が見える。スプライトの暗い画素だけを
       薄いグレーから元の黒へ滑らかに補間する (色変換キャッシュ方式、
       濃さはこの inkT() 経由で48段階に量子化)。明るい画素 (目帯の
       白) は変換しない。
       段階2 (200個超): 真っ黒のまま、a = (取得数-200)/200 (400個で最大)
       で墨のオーラが広がる (この側は従来どおり線形・変更なし)。
       ランが終われば次はまた薄い色から */
    function inkT() {
      var p = clamp(orbCount / 200, 0, 1);
      if (p <= 0) return 0;
      if (p >= 1) return 1;
      var quad = 1 - (1 - p) * (1 - p); // イーズアウト (2次)
      return 0.7 * quad + 0.3 * Math.sqrt(p);
    }
    function auraT() { return clamp((orbCount - 200) / 200, 0, 1); }
    var INK_STEPS = 48; // 濃さの量子化段数 (この段が変わった時だけ色変換を作り直す)
    var tintCache = new Map(); // Image -> { lvl, cv } 変換済みキャンバス
    function getTinted(img) {
      var t = inkT();
      if (t >= 0.999 || !img || !img.naturalWidth) return img;
      var lvl = Math.round(t * INK_STEPS);
      if (lvl >= INK_STEPS) return img;
      var ent = tintCache.get(img);
      if (ent && ent.lvl === lvl) return ent.cv;
      var w = img.naturalWidth, h = img.naturalHeight;
      var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      var g2 = cv.getContext("2d");
      g2.drawImage(img, 0, 0);
      var idata;
      try { idata = g2.getImageData(0, 0, w, h); } catch (e) { return img; }
      var d = idata.data;
      var k = 1 - lvl / INK_STEPS; // 薄さの残量 (1=最も薄い / 0=元の黒)
      for (var i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) continue; // 透明部は触らない
        var r = d[i], gg = d[i + 1], b = d[i + 2];
        var lum = r * 0.299 + gg * 0.587 + b * 0.114;
        if (lum > 205) continue; // 目帯などの白は白のまま
        // 薄墨色: ウォームグレー。元の濃淡の気配 (±) は少しだけ残す
        var tr = 172 + (r - 34) * 0.14;
        var tg = 167 + (gg - 30) * 0.14;
        var tb = 154 + (b - 22) * 0.14;
        d[i] = r + (tr - r) * k;
        d[i + 1] = gg + (tg - gg) * k;
        d[i + 2] = b + (tb - b) * k;
      }
      g2.putImageData(idata, 0, 0);
      tintCache.set(img, { lvl: lvl, cv: cv });
      return cv;
    }
    function showGameOver() {
      state = "over";
      if (dprDirty) { dprDirty = false; fitCanvas(); } // 適応DPRは境界でのみ適用
      stageEl.classList.remove("in-game");
      var dist = Math.floor(scroll / PX_PER_M);
      var sc = Math.floor(score);
      var prevBestScore = bestScore, prevBestDist = bestDist;
      if (sc > bestScore) bestScore = sc;
      if (dist > bestDist) bestDist = dist;
      document.getElementById("resDist").textContent = dist;
      document.getElementById("resScore").textContent = sc;
      document.getElementById("resNear").textContent = nearCount;
      document.getElementById("resBreak").textContent = breakCount;
      document.getElementById("resOrbs").textContent = orbCount;
      document.getElementById("resOnigiri").textContent = onigiriCount;
      document.getElementById("resBunshin").textContent = bunshinSaveCount;
      document.getElementById("resWave").textContent = waveKillCount;
      document.getElementById("resFuuton").textContent = fuutonKillCount;
      document.getElementById("resMult").textContent = "×" + maxMult.toFixed(1);
      // 巻物チャレンジの結果 (第12次)
      var resMissionEl = document.getElementById("resMission");
      if (resMissionEl && mission) {
        if (mission.done) resMissionEl.innerHTML = "巻物：「" + missionText(mission) + "」 <span class=\"done\">達成！（+300）</span>";
        else resMissionEl.textContent = "巻物：「" + missionText(mission) + "」 未達（" + Math.min(missionProgress(), mission.target) + "／" + mission.target + missionUnit(mission) + "）";
      }
      hideBanners();
      // ベストとの差: 距離・スコア別に、更新時は「新記録」を明示する
      var bestEl = document.getElementById("overBest");
      if (prevBestDist === 0 && prevBestScore === 0) {
        bestEl.textContent = "このタブでの初記録（ベスト — 距離 " + bestDist + "m ・ スコア " + bestScore + "）";
      } else {
        var dMsg = dist > prevBestDist ? "<span class=\"record\">距離 新記録！</span>（前ベスト " + prevBestDist + "m を +" + (dist - prevBestDist) + "m）"
          : dist === prevBestDist ? "距離 ベストタイ（" + prevBestDist + "m）"
          : "距離 ベストまであと " + (prevBestDist - dist) + "m";
        var sMsg = sc > prevBestScore ? "<span class=\"record\">スコア 新記録！</span>（前ベスト " + prevBestScore + " を +" + (sc - prevBestScore) + "）"
          : sc === prevBestScore ? "スコア ベストタイ（" + prevBestScore + "）"
          : "スコア ベストまであと " + (prevBestScore - sc);
        bestEl.innerHTML = dMsg + "　／　" + sMsg;
      }
      // 称号 (第19次): そのランで条件を満たした中で最もレアなものを表示し、
      // 満たした称号はすべて取得記録に残す。新規取得があれば明示する
      var titleMetrics = {
        dist: dist, score: sc, orbs: orbCount, near: nearCount, katon: katonKillCount,
        breaks: breakCount, dash: dashUseCount, onigiri: onigiriCount, bunshin: bunshinSaveCount,
        enemy: enemyKillCount, mission: !!(mission && mission.done), lap: lapAt(dist),
        mult: maxMult, time: runTime,
        // 第25次: 水遁・風遁のメトリクスと3遁そろいの判定
        suiton: suitonUses, waveKills: waveKillCount, waveGaps: waveGapCount,
        fuuton: fuutonUses, tornadoKills: fuutonKillCount, tornadoChain: fuutonMaxChain,
        allJutsu: katonPickupCount > 0 && suitonUses > 0 && fuutonUses > 0,
        twoJutsu: (katonPickupCount > 0) + (suitonUses > 0) + (fuutonUses > 0) >= 2
      };
      var award = awardTitles(titleMetrics);
      var ttl = award.display;
      var sealEl = document.getElementById("resSeal");
      sealEl.textContent = ttl.seal;
      sealEl.className = "rakkan" + (ttl.rarity === 2 ? " muri" : (ttl.rarity === 1 ? " rare" : ""));
      document.getElementById("resTitleName").textContent = ttl.name;
      var newEl = document.getElementById("resNewTitle");
      if (newEl) {
        if (award.fresh.length) {
          var fnames = [];
          for (var fi = 0; fi < award.fresh.length; fi++) fnames.push("「" + award.fresh[fi].name + "」");
          newEl.textContent = "新称号！ " + fnames.join(" ");
          newEl.hidden = false;
        } else {
          newEl.textContent = "";
          newEl.hidden = true;
        }
      }
      document.getElementById("overReason").textContent = "死因: " + deathReason;
      document.getElementById("overComment").textContent = "「" + (deathTrap ? "欲をかいた。" : (DEATH_COMMENTS[deathReason] || "修行が足りない。")) + "」"; // トラップ内で死んだら専用コメント (死因表示は従来どおり)
      recordRunStats(); // プレイ計測 (P0): このランを累計に記録
      // 第17次・仕様3: 結果画面にシード／同じコースの選択肢は出さない
      // (シード再現の内部仕組み自体は残す)
      el.ovOver.hidden = false;
      el.btnMain.textContent = "スタート";
      AudioSys.stopBgm();
    }
    function setPause(on) {
      if (on && state === "playing") { state = "paused"; el.ovPause.hidden = false; AudioSys.stopBgm(); }
      else if (!on && state === "paused") { state = "playing"; el.ovPause.hidden = true; AudioSys.startBgm(); }
    }
    function togglePause() {
      if (state === "playing") setPause(true);
      else if (state === "paused") setPause(false);
    }

    document.getElementById("btnStart").addEventListener("click", function () { startRun((Math.random() * 900000 + 10000) | 0); });
    /* 称号一覧 (第19次／第20次): タイトル画面と結果画面の両方から開ける。
       「戻る」は開いた元 (タイトル or 結果) に戻る。ゲームは開始しない */
    var titlesReturnTo = "title"; // "title" | "over"
    function openTitles(from) {
      titlesReturnTo = from;
      renderTitlesList();
      document.getElementById("ovTitles").hidden = false;
      if (from === "over") el.ovOver.hidden = true; else el.ovTitle.hidden = true;
    }
    function closeTitles() {
      document.getElementById("ovTitles").hidden = true;
      if (titlesReturnTo === "over") el.ovOver.hidden = false; else el.ovTitle.hidden = false;
    }
    document.getElementById("btnTitles").addEventListener("click", function () { openTitles("title"); });
    document.getElementById("btnTitlesFromOver").addEventListener("click", function () { openTitles("over"); });
    document.getElementById("btnTitlesClose").addEventListener("click", function () { closeTitles(); });
    /* オープニングへ戻る (第20次): 結果画面からタイトル画面へ遷移する。
       背景は初期表示と同じデモコース (シード固定) に戻し、状態も title に
       戻す。リスタート計測 (pendingRestart) はここでは消費しない —
       タイトルから再び開始した時も「死亡後の再挑戦」として数えるため、
       startRun 側の計数条件を over / title 両対応にした */
    function goToOpening() {
      document.getElementById("ovTitles").hidden = true;
      el.ovOver.hidden = true; el.ovPause.hidden = true;
      reset(20261117);
      state = "title";
      stageEl.classList.remove("in-game");
      el.ovTitle.hidden = false;
      el.btnMain.textContent = "スタート";
      AudioSys.stopBgm();
      hideBanners();
    }
    document.getElementById("btnToTitle").addEventListener("click", function () { goToOpening(); });
    // 第17次・仕様3＋第20次: 死亡後の主ボタンは「再スタート」(新しいコース) のまま。
    // その下に副ボタン (称号一覧／オープニングへ戻る) を追加した (同じコースは復活させない)
    document.getElementById("btnRestart").addEventListener("click", function () { startRun((Math.random() * 900000 + 10000) | 0); });
    document.getElementById("btnResume").addEventListener("click", function () { setPause(false); });
    document.getElementById("btnPause").addEventListener("click", function () { togglePause(); });
    el.btnMain.addEventListener("click", function () {
      if (state === "playing" || state === "paused") startRun((Math.random() * 900000 + 10000) | 0);
      else startRun((Math.random() * 900000 + 10000) | 0);
    });
    var btnSound = document.getElementById("btnSound");
    btnSound.addEventListener("click", function () {
      AudioSys.init();
      AudioSys.muted = !AudioSys.muted;
      if (AudioSys.master) AudioSys.master.gain.value = AudioSys.muted ? 0 : 0.9;
      btnSound.textContent = AudioSys.muted ? "音：オフ" : "音：オン";
    });
    document.getElementById("btnSeedGo").addEventListener("click", function () {
      var v = parseInt(document.getElementById("seedInput").value, 10);
      if (isNaN(v)) return;
      startRun(Math.abs(v) % 1000000000);
    });

    /* ---------------- 向き対応 (回転表示モード) ----------------
       iPhoneではWeb側から向きを固定できない (Orientation lock未実装 /
       iPhone Safariは要素フルスクリーン不可 / PWA orientation無視 — 調査済み)。
       そのため: 横向きビューポートでは通常表示、縦向きビューポートでは
       ステージ全体を rotate(90deg) で回転表示し、寸法は縦横を入れ替えて
       画面幅いっぱいにする。判定はビューポート実測を主系にする
       (ホストアプリが縦固定でも「実際に起きた形状」で分岐できる)。 */
    var stageShell = document.getElementById("stageShell");
    var stageRotator = document.getElementById("stageRotator");
    function layoutStage() {
      /* 寸法はCSSが担う: 殻は表示領域の 100% × 100dvh、回転時は rotator が
         幅100dvh / 高さ100vw で、回転後の外形がビューポート全体と一致する。
         JS側はキャンバス解像度の再計算だけを行う */
      fitCanvas();
    }
    function applyOrientation() {
      rotatedView = window.innerHeight > window.innerWidth;
      document.body.classList.toggle("rot-port", rotatedView);
      layoutStage();
      fitCanvas();
    }
    var orientMQ = window.matchMedia ? window.matchMedia("(orientation: portrait)") : null;
    if (orientMQ && orientMQ.addEventListener) orientMQ.addEventListener("change", applyOrientation);
    if (window.screen && screen.orientation && screen.orientation.addEventListener) {
      screen.orientation.addEventListener("change", applyOrientation);
    }
    window.addEventListener("orientationchange", applyOrientation);

    /* ---------------- キャンバス解像度 (Phase 3: 実表示デバイスpxに一致) ----------------
       バックストアは「論理サイズ×DPR」ではなく、実際に表示される矩形
       (ステージのCSS px) × devicePixelRatio に一致させる。DPR上限は3
       (タイル化で毎フレームの作業が blit 中心になったため現実的)。
       重い環境向けの保険として適応DPR (3→2.5→2) を持つ: プレイ中の
       フレーム時間の移動平均が悪化したら次回開始時／終了時にだけ段階的に
       下げ、プレイ中の解像度変更 (＝新たなブレの原因) はしない。
       フィールドは等倍スケールで中央に置き、オフセットはデバイス整数に
       丸める (タイルの 1:1 blit がデバイス格子に乗るように)。
       viewScale/viewOX/viewOY はデバイスpx、viewScaleCss 系はCSS px版 */
    var viewScale = 1, viewOX = 0, viewOY = 0;
    var viewScaleCss = 1, viewOXC = 0, viewOYC = 0;
    var adaptDprCap = 3, frameEma = 1 / 60, slowAcc = 0, dprDirty = false;
    function fitCanvas() {
      // clientWidth/Height は transform の影響を受けないレイアウト寸法
      // (回転時もステージ本来の横×縦が取れる)
      var w = stageEl.clientWidth, h = stageEl.clientHeight;
      if (!w || !h) return;
      var dpr = Math.min(window.devicePixelRatio || 1, adaptDprCap);
      var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      viewScale = Math.min(bw / W, bh / H);
      viewOX = Math.round((bw - W * viewScale) / 2);
      viewOY = Math.round((bh - H * viewScale) / 2);
      viewScaleCss = Math.min(w / W, h / H);
      viewOXC = (w - W * viewScaleCss) / 2;
      viewOYC = (h - H * viewScaleCss) / 2;
      tileCache.clear(); // 解像度が変わったらタイルは作り直す (生成は決定的なので絵は不変)
    }
    window.addEventListener("resize", applyOrientation);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", applyOrientation);

    /* 初期化: タイトル画面の背景としてコースを静止描画 */
    reset(20261117);
    renderStats();
    document.getElementById("titleSeed").textContent = "スタートごとに新しいシードでコース生成（死亡後は「再スタート」で新しいコースへ）";
    applyOrientation();
    requestAnimationFrame(frame);
