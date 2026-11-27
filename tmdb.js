/* ===================== TMDB から作品の情報を取る（画面には触らない） =====================
   TMDB（https://www.themoviedb.org）：ドラマ・映画などアニメ以外の作品用。APIキー（無料）が必要で、設定の「TMDB APIキー」に入れる（master.tmdbKey）。
   取れるもの：タイトル・開始日／終了日・放送局・縦画像・公式サイト・Netflixで配信しているか。放送時間・NetflixのURLは取れない。
   画面（al-ui.js）で AniList と同じように扱えるよう、結果は AniList と同じ形（title.native・startDate など）にそろえて返す。
   作品の番号は「tv:123」「movie:123」の文字（テレビと映画で番号が別のため） */
(() => {
  const API = "https://api.themoviedb.org/3";
  const IMG = "https://image.tmdb.org/t/p/";
  const key = () => String((typeof master === "object" && master && master.tmdbKey) || "").trim();

  async function get(path, params = {}) {
    const k = key();
    if (!k) throw Object.assign(new Error("TMDBのAPIキーが未設定です"), { noKey: true });
    const q = new URLSearchParams({ language: "ja-JP", ...params });
    /* v3のAPIキー（32文字）はURLに、読み取りトークン（長い文字）はヘッダーに付ける */
    const tok = k.length > 40;
    if (!tok) q.set("api_key", k);
    const r = await fetch(`${API}${path}?${q}`, { headers: tok ? { Authorization: `Bearer ${k}`, Accept: "application/json" } : { Accept: "application/json" } });
    const j = await r.json().catch(() => null);
    if (r.status === 401) throw Object.assign(new Error("TMDBのAPIキーが正しくありません"), { noKey: true });
    if (!r.ok || !j) throw new Error((j && j.status_message) || `TMDB ${r.status}`);
    return j;
  }

  const ymd = s => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
    return m ? { year: +m[1], month: +m[2], day: +m[3] } : {};
  };
  const STATUS = { Ended: "FINISHED", Canceled: "FINISHED", Released: "FINISHED", "Returning Series": "RELEASING", "In Production": "NOT_YET_RELEASED", Planned: "NOT_YET_RELEASED", "Post Production": "NOT_YET_RELEASED", Rumored: "NOT_YET_RELEASED" };

  /* TMDB の1件 → AniList と同じ形 */
  function shape(x, type) {
    const tv = type === "tv";
    const name = (tv ? x.name : x.title) || "",
      orig = (tv ? x.original_name : x.original_title) || "";
    const date = tv ? x.first_air_date : x.release_date;
    const s = ymd(date);
    return {
      id: `${type}:${x.id}`,
      src: "tm",
      type,
      title: { native: name || orig, romaji: orig && orig !== name ? orig : "" },
      synonyms: orig && orig !== name ? [orig] : [],
      format: tv ? "TV" : "MOVIE",
      status: STATUS[x.status] || (date && new Date(date) > new Date() ? "NOT_YET_RELEASED" : ""),
      episodes: x.number_of_episodes || null,
      seasonYear: s.year || null,
      season: null,
      startDate: s,
      endDate: tv ? ymd(x.last_air_date) : s,
      coverImage: { medium: x.poster_path ? `${IMG}w185${x.poster_path}` : "", large: x.poster_path ? `${IMG}w500${x.poster_path}` : "" },
      country: (x.origin_country || [])[0] || x.original_language || "",
    };
  }

  /* 検索語からシーズンの番号を外す（TMDB はシーズンごとの作品がなく、1つの番組の中にシーズンが入っているため）
     「シーズン2」「Season 2」「2nd season」「第2シリーズ」「第二期」「Ⅱ」「 2」（最後の数字は前に空白があるときだけ） */
  const KAN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const ROMAN = { II: 2, III: 3, IV: 4, VI: 6, VII: 7, VIII: 8, IX: 9 };
  function splitSeason(q0) {
    const q = String(q0 || "").normalize("NFKC").trim();
    const pats = [
      [/[\s　]*(?:シーズン|season)[\s　]*(\d{1,2})[\s　]*$/i, m => +m[1]],
      [/[\s　]*(\d{1,2})(?:st|nd|rd|th)[\s　]*season[\s　]*$/i, m => +m[1]],
      [/[\s　]*第[\s　]*(\d{1,2}|[一二三四五六七八九十])[\s　]*(?:シリーズ|シーズン|期|章|部)[\s　]*$/, m => +m[1] || KAN[m[1]]],
      /* Ⅱ などは NFKC で II になる。英字の続きでないときだけ */
      [/(?<![A-Za-z])[\s　]*(II|III|IV|VI|VII|VIII|IX)[\s　]*$/, m => ROMAN[m[1]]],
      [/[\s　]+(\d{1})$/, m => +m[1]],
    ];
    for (const [re, f] of pats) {
      const m = re.exec(q);
      if (m && m.index > 0) {
        const n = f(m);
        if (n >= 1) return { base: q.slice(0, m.index).replace(/[\s　:：\-]+$/, ""), n };
      }
    }
    return { base: q, n: 0 };
  }
  const seasonNo = s => +s.season_number || 0;
  /* 番組名にシーズン名を付ける（シーズン名に番組名が入っていればそのまま） */
  const seasonTitle = (show, sn) => {
    const nm = (sn.name || "").trim() || `シーズン${sn.season_number}`;
    return nm.includes(show) ? nm : `${show} ${nm}`;
  };
  /* 番組（くわしい情報）＋シーズン → AniList と同じ形。番号は「tv:123:2」 */
  function shapeSeason(x, sn, eps) {
    const m = shape(x, "tv");
    const show = m.title.native;
    const s = ymd(sn.air_date);
    const aired = (eps || []).map(e => e.air_date).filter(Boolean).sort();
    const today = new Date(Date.now() + 540 * 60000).toISOString().slice(0, 10);
    const n = eps ? eps.length : sn.episode_count || null;
    const last = aired.length ? aired[aired.length - 1] : "";
    const later = seasonNo(sn) < (x.number_of_seasons || 0);
    const allAired = !!last && last <= today && (!eps || aired.length === eps.length);
    /* 話の一覧がないとき（検索結果）は、後のシーズンがある・番組が終わっていれば放送済み */
    const done = eps ? allAired : later || STATUS[x.status] === "FINISHED";
    const status = !sn.air_date || sn.air_date > today ? "NOT_YET_RELEASED" : done ? "FINISHED" : "RELEASING";
    const poster = sn.poster_path || x.poster_path;
    return {
      ...m,
      id: `tv:${x.id}:${seasonNo(sn)}`,
      season_number: seasonNo(sn),
      title: { native: seasonTitle(show, sn), romaji: m.title.romaji },
      synonyms: [show, ...m.synonyms],
      status,
      episodes: n,
      seasonYear: s.year || null,
      startDate: s,
      endDate: status === "FINISHED" ? ymd(last) : {},
      coverImage: { medium: poster ? `${IMG}w185${poster}` : "", large: poster ? `${IMG}w500${poster}` : "" },
    };
  }

  /* タイトルで探す（ドラマと映画をまとめて）。日本の作品を先に。
     シーズンが2つ以上あるドラマは、シーズンごとの候補に分ける（検索語にシーズンの番号があれば、そのシーズンを先頭に） */
  async function search(q) {
    const { base, n } = splitSeason(q);
    const runs = [get("/search/multi", { query: base, include_adult: "false" })];
    if (base !== String(q).trim()) runs.push(get("/search/multi", { query: q, include_adult: "false" }).catch(() => ({ results: [] })));
    const all = (await Promise.all(runs)).flatMap(j => j.results || []);
    const seen = new Set();
    const raw = all.filter(x => (x.media_type === "tv" || x.media_type === "movie") && !seen.has(x.media_type + x.id) && seen.add(x.media_type + x.id));
    const jp = x => ((x.origin_country || []).includes("JP") || x.original_language === "ja" ? 0 : 1);
    const l = raw.sort((a, b) => jp(a) - jp(b)).slice(0, 12);
    /* 上の方のドラマだけ、シーズンの一覧を取る（取れなければ番組のまま） */
    const tvTop = new Set(l.filter(x => x.media_type === "tv").slice(0, 4).map(x => x.id));
    const out = await Promise.all(
      l.map(async x => {
        if (x.media_type !== "tv" || !tvTop.has(x.id)) return [shape(x, x.media_type)];
        try {
          const d = await get(`/tv/${x.id}`);
          const ss = (d.seasons || []).filter(s => seasonNo(s) > 0);
          if (ss.length < 2) return [shape({ ...x, ...d }, "tv")];
          return ss.map(s => shapeSeason(d, s));
        } catch (e) {
          return [shape(x, "tv")];
        }
      }),
    );
    let res = out.flat();
    if (n) res = [...res.filter(m => m.season_number === n), ...res.filter(m => m.season_number !== n)];
    return res.slice(0, 24);
  }

  /* 1作品のくわしい情報：放送局・公式サイト・配信サイト（日本）。「tv:123:2」はシーズン2の開始日・終了日・話数・画像 */
  async function detail(id) {
    const [type, n, sno] = String(id).split(":");
    const x = await get(`/${type}/${n}`, { append_to_response: type === "movie" ? "watch/providers,release_dates" : "watch/providers" });
    let m = shape(x, type);
    if (type === "tv" && sno) {
      const sn = await get(`/tv/${n}/season/${sno}`);
      m = shapeSeason(x, sn, sn.episodes || []);
    }
    /* 映画の公開日は日本の劇場公開日があればそちら */
    if (type === "movie") {
      const jp = (x.release_dates?.results || []).find(r => r.iso_3166_1 === "JP");
      const th = jp && (jp.release_dates.find(d => d.type === 3) || jp.release_dates[0]);
      if (th && th.release_date) m.startDate = m.endDate = ymd(th.release_date);
    }
    const pv = x["watch/providers"]?.results?.JP || {};
    m.providers = [...new Set([...(pv.flatrate || []), ...(pv.free || []), ...(pv.ads || [])].map(p => p.provider_name))];
    m.networks = (x.networks || []).map(w => w.name);
    m.homepage = x.homepage || "";
    return m;
  }

  async function image(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`画像 ${r.status}`);
    return r.blob();
  }

  globalThis.TM = { search, detail, image, splitSeason, hasKey: () => !!key() };
})();
