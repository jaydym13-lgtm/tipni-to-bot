// =========================================================================
// 🤖 TIPNI TO! - TRVALÝ STAVOVÝ BACKEND DAEMON V2.6.0 (bot.mjs)
// =========================================================================
import admin from "firebase-admin";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import process from "process";
import http from "http";

import { PRAVIDLA_LIG } from "./rules.js";

// --- ⚙️ PROSTŘEDÍ A MULTI-LEAGUE KONFIGURACE ---
const SEZONA_ID = process.env.SEZONA_ID || "2026_2027";
const PORT = process.env.PORT || 8080;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";

// 🗺️ ČÍSELNÍK SPORTOVNÍCH API PROVIDERŮ A ID SOUTĚŽÍ
const LIGY_API_MAPA = {
    "Chance Liga": { id: "4631", provider: "THESPORTSDB" },
    "Premier League": { id: "4328", provider: "THESPORTSDB" },
    "MS ve fotbale": { id: "4429", provider: "THESPORTSDB" },
    "Tipsport Extraliga": { id: "4923", provider: "THESPORTSDB" },
    "MS v hokeji": { id: "4859", provider: "THESPORTSDB" },
    "Liga mistrů": { id: "4480", provider: "THESPORTSDB" }
};

// Seznam lig, které má bot v tomto běhu živě obsluhovat
const SEZNAM_LIG = (process.env.ACTIVE_LEAGUES || "Chance Liga,Premier League,Liga mistrů,MS ve fotbale,Tipsport Extraliga,MS v hokeji")
    .split(",")
    .map(l => l.trim())
    .filter(Boolean);

// Inicializace Cloudflare R2 Klienta přes AWS S3 SDK
const r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || ""
    }
});
const BUCKET_NAME = process.env.R2_BUCKET_NAME || "tipni-to-data";

// --- 🔐 INICIALIZACE FIREBASE ADMIN SDK ---
admin.initializeApp({
    credential: admin.credential.cert("./service-account.json")
});
const db = admin.firestore();

// --- 🧠 IN-MEMORY RAM STATE (Stavová paměť daemona) ---
const RAM_USERS_PROFILES = {}; 
const RAM_USERS_TIPS = {};     
const RAM_CENTRAL_MATCHES = {}; 

// 📊 RAM MEZIPAMĚŤ KURZŮ (1-X-2)
const RAM_CENTRAL_ODDS = {};

// 🔒 DETERMINISTICKÉ ZÁMKY A PAMĚŤ OTISKŮ (0 zbytečných pulsů a zápisů)
let RAM_IS_SYNCING = false;
const RAM_LAST_DATA_SIGNATURES = {};

// 🧮 AUTONOMNÍ VÝPOČET SEZÓNNÍ FORMY TÝMU Z RAM (0 API VOLÁNÍ)
function spoctiSezonniFormuTymu(tym, datumZapasuIso, allMatchesInLeague) {
    const tymNorm = String(tym || '').trim().toLowerCase();
    if (!tymNorm || tymNorm === 'neznámý') return [];

    const refMs = Date.parse(datumZapasuIso) || Date.now();

    const odehrane = Object.values(allMatchesInLeague).filter(z => {
        const dNorm = String(z.domaci || '').trim().toLowerCase();
        const hNorm = String(z.hoste || '').trim().toLowerCase();
        const hralTym = (dNorm === tymNorm || hNorm === tymNorm);
        const jeDohrano = (z.vysledek_domaci !== undefined && z.vysledek_domaci !== null && z.apiStatus === "FINISHED");
        const zMs = Date.parse(z.datum);
        const jeDrive = !isNaN(zMs) && zMs < refMs;
        return hralTym && jeDohrano && jeDrive;
    });

    odehrane.sort((a, b) => (Date.parse(b.datum) || 0) - (Date.parse(a.datum) || 0));
    const poslednich5 = odehrane.slice(0, 5).reverse(); // 👈 Otočeno: vlevo starší -> vpravo nejnovější (poslední odehraný)
    if (poslednich5.length === 0) return [];

    return poslednich5.map(z => {
        const dNorm = String(z.domaci || '').trim().toLowerCase();
        const jeDoma = (dNorm === tymNorm);
        const gDom = parseInt(z.vysledek_domaci, 10);
        const gHos = parseInt(z.vysledek_hoste, 10);
        const gMy = jeDoma ? gDom : gHos;
        const gOni = jeDoma ? gHos : gDom;

        if (gMy > gOni) return 'V';
        if (gMy === gOni) return 'R';
        return 'P';
    });
}

// =========================================================================
// 🌐 RAPIDAPI (SPORTAPI7) - KURZOVÝ ENGINE A PŘEKLADOVÁ MAPA ID
// =========================================================================

// 🗺️ RAM MAPA SOFASCORE ID -> { league, matchKey, domaci, hoste }
const RAM_EVENT_MAP = {};
const EVENT_MAP_R2_KEY = `sezony/${SEZONA_ID}/event_map.json`;
const ODDS_R2_KEY = `sezony/${SEZONA_ID}/central_odds.json`;

const PROCESSED_DAYS_R2_KEY = `sezony/${SEZONA_ID}/processed_odds_days.json`;
const RAM_PROCESSED_ODDS_DAYS = new Set();

async function nactiProcessedDaysZR2() {
    try {
        const res = await r2Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: PROCESSED_DAYS_R2_KEY }));
        const str = await res.Body.transformToString();
        const arr = JSON.parse(str);
        if (Array.isArray(arr)) {
            arr.forEach(d => RAM_PROCESSED_ODDS_DAYS.add(d));
            console.log(`🛡️ R2 TREZOR: Načteno ${RAM_PROCESSED_ODDS_DAYS.size} již odbavených dní kurzů.`);
        }
    } catch (e) {}
}

async function ulozProcessedDaysDoR2() {
    try {
        await r2Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: PROCESSED_DAYS_R2_KEY,
            Body: JSON.stringify(Array.from(RAM_PROCESSED_ODDS_DAYS)),
            ContentType: "application/json"
        }));
    } catch (e) {
        console.error("❌ R2 TREZOR: Selhalo uložení odbavených dní kurzů:", e.message);
    }
}

// Číselník turnajů na SofaScore s přesnými ID turnajů a sezón
const SOFASCORE_TOURNAMENTS = {
    "Chance Liga": { id: 49, seasonId: 96966, sport: "football", isUnique: false },
    "Premier League": { id: 1, seasonId: 96668, sport: "football", isUnique: false },
    "Tipsport Extraliga": { id: 109, seasonId: 96126, sport: "ice-hockey", isUnique: false },
    "Liga mistrů": { id: 7, seasonId: 96518, sport: "football", isUnique: true }
};

function prevedZlomekNaKurz(fraction) {
    if (!fraction || typeof fraction !== 'string') return null;
    const parts = fraction.split('/');
    if (parts.length !== 2) return null;
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (isNaN(num) || isNaN(den) || den === 0) return null;
    return parseFloat(((num / den) + 1).toFixed(2));
}

// 📦 NAČTENÍ A ZÁPIS MAPY ID Z/DO R2
async function nactiEventMapZR2() {
    try {
        const response = await r2Client.send(new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: EVENT_MAP_R2_KEY
        }));
        const strData = await response.Body.transformToString();
        const json = JSON.parse(strData);
        if (json && typeof json === "object") {
            Object.assign(RAM_EVENT_MAP, json);
            console.log(`📦 R2 TREZOR: Načtena mapa ${Object.keys(RAM_EVENT_MAP).length} zápasových ID.`);
        }
    } catch (err) {
        console.log("ℹ️ R2 TREZOR: event_map.json na R2 zatím neexistuje.");
    }
}

async function ulozEventMapDoR2() {
    try {
        await r2Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: EVENT_MAP_R2_KEY,
            Body: JSON.stringify(RAM_EVENT_MAP, null, 2),
            ContentType: "application/json"
        }));
        console.log("💾 R2 TREZOR: Mapa zápasových ID úspěšně uložena na R2.");
    } catch (err) {
        console.error("❌ R2 TREZOR: Selhalo uložení event_map.json:", err.message);
    }
}

// 🗺️ 1× MĚSÍČNĚ: STAŽENÍ SOFASCORE UDÁLOSTÍ PRO AUTOMATICKÉ PÁROVÁNÍ ID
async function synchronizujSofaScoreEventMap() {
    if (!RAPIDAPI_KEY) {
        console.warn("⚠️ RAPIDAPI: Chybí RAPIDAPI_KEY pro generování mapy ID!");
        return;
    }

    console.log("🗺️ MAPPER: Spouštím měsíční generování překladové mapy ID...");
    let noveNalezeno = 0;

    for (const [leagueName, cfg] of Object.entries(SOFASCORE_TOURNAMENTS)) {
        try {
            const prefix = cfg.isUnique ? "unique-tournament" : "tournament";
            const url = `https://sportapi7.p.rapidapi.com/api/v1/${prefix}/${cfg.id}/season/${cfg.seasonId}/events/next/0`;
            const res = await fetch(url, {
                headers: {
                    "x-rapidapi-key": RAPIDAPI_KEY,
                    "x-rapidapi-host": "sportapi7.p.rapidapi.com"
                },
                signal: AbortSignal.timeout(9000)
            });

            if (!res.ok) {
                console.log(`⚠️ MAPPER [${leagueName}]: API status ${res.status}`);
                continue;
            }

            const data = await res.json();
            const events = data?.events || [];

            events.forEach(ev => {
                const eventId = String(ev.id);
                const rawHome = ev.homeTeam?.name || "";
                const rawAway = ev.awayTeam?.name || "";
                const dNorm = slovnikTymu[rawHome] || rawHome;
                const hNorm = slovnikTymu[rawAway] || rawAway;
                const matchKey = `${PL_NORM(dNorm)} vs ${PL_NORM(hNorm)}`;

                RAM_EVENT_MAP[eventId] = {
                    league: leagueName,
                    matchKey: matchKey,
                    domaci: dNorm,
                    hoste: hNorm
                };
                noveNalezeno++;
            });
            console.log(`🗺️ MAPPER [${leagueName}]: Úspěšně načteno ${events.length} zápasů.`);
        } catch (err) {
            console.error(`❌ MAPPER [${leagueName}]: Selhala synchronizace turnaje:`, err.message);
        }
    }

    if (noveNalezeno > 0) {
        await ulozEventMapDoR2();
    }
    console.log(`✅ MAPPER: Dokončeno. V paměti je celkem ${Object.keys(RAM_EVENT_MAP).length} propojených zápasů.`);
}

// Jednorázové stažení denního balíku kurzů pro daný sport z RapidAPI
async function stahniDenniKurzyRapidApi(sport, datumIso) {
    if (!RAPIDAPI_KEY) {
        console.warn("⚠️ RAPIDAPI: Není nastaven RAPIDAPI_KEY v Environment proměnných!");
        return 0;
    }

    const url = `https://sportapi7.p.rapidapi.com/api/v1/sport/${sport}/odds/1/${datumIso}`;

    try {
        const res = await fetch(url, {
            method: "GET",
            headers: {
                "x-rapidapi-key": RAPIDAPI_KEY,
                "x-rapidapi-host": "sportapi7.p.rapidapi.com"
            },
            signal: AbortSignal.timeout(9000)
        });

        const zbyvaDotazu = res.headers.get("x-ratelimit-requests-remaining");
        if (zbyvaDotazu !== null) {
            console.log(`📊 RAPIDAPI: Úspěšný dotaz (${sport} pro ${datumIso}). Zbývá volání do limitu: ${zbyvaDotazu}`);
        }

        if (res.status === 429) {
            console.warn("🛑 RAPIDAPI: Dosažen měsíční Hard Limit (429 Too Many Requests). Pozastavuji stahování.");
            return 0;
        }

        if (!res.ok) {
            console.log(`⚠️ RAPIDAPI: Server vrátil kód ${res.status} pro ${sport}/${datumIso}`);
            return 0;
        }

        const data = await res.json();
        const oddsMap = data?.odds || {};
        let naparovano = 0;

        for (const [eventId, matchOdds] of Object.entries(oddsMap)) {
            if (matchOdds.suspended) continue;

            const choices = matchOdds.choices || [];
            let o1 = null, oX = null, o2 = null;

            choices.forEach(ch => {
                const decimalVal = prevedZlomekNaKurz(ch.fractionalValue || ch.initialFractionalValue);
                if (ch.name === "1") o1 = decimalVal;
                else if (ch.name === "X" || ch.name === "0") oX = decimalVal;
                else if (ch.name === "2") o2 = decimalVal;
            });

            if (o1 && o2) {
                const oddsObj = {
                    "1": o1,
                    "X": oX,
                    "2": o2,
                    bookmaker: "Bet365"
                };

                // Párování přes přeloženou mapu podle jmen týmů
                const meta = RAM_EVENT_MAP[eventId];
                if (meta && meta.league) {
                    if (!RAM_CENTRAL_ODDS[meta.league]) RAM_CENTRAL_ODDS[meta.league] = {};
                    RAM_CENTRAL_ODDS[meta.league][meta.matchKey] = oddsObj;
                    RAM_CENTRAL_ODDS[meta.league][eventId] = oddsObj;
                } else {
                    SEZNAM_LIG.forEach(leagueName => {
                        if (!RAM_CENTRAL_ODDS[leagueName]) RAM_CENTRAL_ODDS[leagueName] = {};
                        RAM_CENTRAL_ODDS[leagueName][eventId] = oddsObj;
                    });
                }
                naparovano++;
            }
        }
        return naparovano;
    } catch (err) {
        console.error(`❌ RAPIDAPI: Selhalo stažení kurzů (${sport} ${datumIso}):`, err.message);
        return 0;
    }
}

// 📦 PERZISTENCE KURZŮ NA CLOUDFLARE R2
async function nactiKurzyZR2() {
    try {
        const response = await r2Client.send(new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: ODDS_R2_KEY
        }));
        const strData = await response.Body.transformToString();
        const json = JSON.parse(strData);
        if (json && typeof json === "object") {
            Object.keys(json).forEach(lKey => {
                if (!RAM_CENTRAL_ODDS[lKey]) RAM_CENTRAL_ODDS[lKey] = {};
                Object.assign(RAM_CENTRAL_ODDS[lKey], json[lKey]);
            });
            console.log("📦 R2 TREZOR: Úspěšně načteny existující kurzy z R2 do RAM.");
        }
    } catch (err) {
        console.log("ℹ️ R2 TREZOR: central_odds.json na R2 zatím neexistuje, začínáme s čistou pamětí.");
    }
}

async function ulozKurzyDoR2() {
    try {
        await r2Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: ODDS_R2_KEY,
            Body: JSON.stringify(RAM_CENTRAL_ODDS, null, 2),
            ContentType: "application/json"
        }));
        console.log("💾 R2 TREZOR: Kurzy byly úspěšně uloženy do central_odds.json na R2.");
    } catch (err) {
        console.error("❌ R2 TREZOR: Selhalo uložení kurzů do R2:", err.message);
    }
}

// ⚽ SMART SYNC PLÁNOVAČ: POUZE PRO FOTBAL (Nedotčeno pro Premier League a Chance Ligu)
async function smartSyncKurzu() {
    const nyni = new Date();
    const denVTydnu = nyni.getDay(); // 0 = neděle, 1 = pondělí, 2 = úterý, 3 = středa, 4 = čtvrtek, 5 = pátek, 6 = sobota

    let startBloku = new Date(nyni);
    let konecBloku = new Date(nyni);

    if (denVTydnu === 6 || denVTydnu === 0 || denVTydnu === 1) {
        const dnyDoUtery = (denVTydnu === 6 ? 3 : (denVTydnu === 0 ? 2 : 1));
        const dnyDoCtvrtka = dnyDoUtery + 2;

        startBloku.setDate(nyni.getDate() + dnyDoUtery);
        startBloku.setHours(0, 0, 0, 0);

        konecBloku.setDate(nyni.getDate() + dnyDoCtvrtka);
        konecBloku.setHours(23, 59, 59, 999);
    } else {
        const dnyDoPatku = (5 - denVTydnu);
        const dnyDoPondeli = dnyDoPatku + 3;

        if (denVTydnu === 5) {
            startBloku = new Date(nyni.getTime() - (2 * 60 * 60 * 1000));
        } else {
            startBloku.setDate(nyni.getDate() + dnyDoPatku);
            startBloku.setHours(0, 0, 0, 0);
        }

        konecBloku.setDate(nyni.getDate() + dnyDoPondeli);
        konecBloku.setHours(23, 59, 59, 999);
    }

    const minTargetMs = startBloku.getTime();
    const maxTargetMs = konecBloku.getTime();

    const datumStartStr = startBloku.toISOString().split("T")[0];
    const datumKonecStr = konecBloku.toISOString().split("T")[0];

    console.log(`⚽ FOTBAL SYNC: Kontroluji fotbalový blok (${datumStartStr} až ${datumKonecStr})...`);

    const dnyKeStazeni = { football: new Set() };

    SEZNAM_LIG.forEach(leagueName => {
        if (leagueName.includes("hokej") || leagueName.includes("Extraliga")) return; // Hokej má vlastní sync
        const zapasy = RAM_CENTRAL_MATCHES[leagueName] || {};
        const sportKlic = "football";

        Object.values(zapasy).forEach(z => {
            if (!z.datum) return;
            const matchMs = Date.parse(z.datum);
            if (isNaN(matchMs)) return;

            if (matchMs >= minTargetMs && matchMs <= maxTargetMs) {
                const matchDate = new Date(matchMs);
                const datumIso = matchDate.toISOString().split("T")[0];
                const matchKey = `${PL_NORM(z.domaci)} vs ${PL_NORM(z.hoste)}`;
                const uzMaKurz = RAM_CENTRAL_ODDS[leagueName]?.[matchKey] || RAM_CENTRAL_ODDS[leagueName]?.[z.id] || z.odds;

                if (!uzMaKurz) {
                    const dayKey = `${sportKlic}_${datumIso}`;
                    if (!RAM_PROCESSED_ODDS_DAYS.has(dayKey)) {
                        dnyKeStazeni[sportKlic].add(datumIso);
                    }
                }
            }
        });
    });

    const pocetFotbalDnu = dnyKeStazeni.football.size;

    if (pocetFotbalDnu === 0) {
        console.log(`🛡️ FOTBAL SYNC: Všechny fotbalové dny do ${datumKonecStr} mají kurzy nebo již byly z API staženy. Přeskakuji API (0 requestů).`);
        return;
    }

    console.log(`🚀 FOTBAL SYNC: Stahuji chybějící kurzy pro ${pocetFotbalDnu} fotbalových dnů.`);

    let celkemNaparovano = 0;
    for (const datum of dnyKeStazeni.football) {
        celkemNaparovano += await stahniDenniKurzyRapidApi("football", datum);
        RAM_PROCESSED_ODDS_DAYS.add(`football_${datum}`);
    }

    await ulozProcessedDaysDoR2();

    if (celkemNaparovano > 0) {
        await ulozKurzyDoR2();
    }

    await planujRekonstrukciAgregatu();
}

// 🏒 HOKEJ SMART SYNC: PŘÍSNÁ 3-FÁZOVÁ KONTROLA VÝHRADNĚ PRO TIPSPORT EXTRALIGU
async function smartSyncKurzuHokej() {
    const nyni = new Date();
    const den = nyni.getDay(); // 0=Ne, 1=Po, 2=Út, 3=St, 4=Čt, 5=Pá, 6=So
    const hod = nyni.getHours();

    let startBloku = new Date(nyni);
    let konecBloku = new Date(nyni);

    // 1. Blok: Sobota 12:00 -> Pondělí 15:00 (pokrývá Ne a Po do 15:00)
    if ((den === 6 && hod >= 12) || den === 0 || (den === 1 && hod < 15)) {
        const dnyOdSoboty = (den === 6) ? 0 : (den === 0 ? 1 : 2);
        startBloku.setDate(nyni.getDate() - dnyOdSoboty);
        startBloku.setHours(12, 0, 0, 0);

        const dnyDoPondeli = (den === 6) ? 2 : (den === 0 ? 1 : 0);
        konecBloku.setDate(nyni.getDate() + dnyDoPondeli);
        konecBloku.setHours(15, 0, 0, 0);
    }
    // 2. Blok: Pondělí 15:00 -> Středa 15:00 (pokrývá Út a St do 15:00)
    else if ((den === 1 && hod >= 15) || den === 2 || (den === 3 && hod < 15)) {
        const dnyOdPondeli = (den === 1) ? 0 : (den === 2 ? 1 : 2);
        startBloku.setDate(nyni.getDate() - dnyOdPondeli);
        startBloku.setHours(15, 0, 0, 0);

        const dnyDoStredy = (den === 1) ? 2 : (den === 2 ? 1 : 0);
        konecBloku.setDate(nyni.getDate() + dnyDoStredy);
        konecBloku.setHours(15, 0, 0, 0);
    }
    // 3. Blok: Středa 15:00 -> Sobota 12:00 (pokrývá Čt, Pá a So do 12:00)
    else {
        const dnyOdStredy = (den === 3) ? 0 : (den === 4 ? 1 : (den === 5 ? 2 : 3));
        startBloku.setDate(nyni.getDate() - dnyOdStredy);
        startBloku.setHours(15, 0, 0, 0);

        const dnyDoSoboty = (den === 3) ? 3 : (den === 4 ? 2 : (den === 5 ? 1 : 0));
        konecBloku.setDate(nyni.getDate() + dnyDoSoboty);
        konecBloku.setHours(12, 0, 0, 0);
    }

    const minTargetMs = startBloku.getTime();
    const maxTargetMs = konecBloku.getTime();

    const datumStartStr = startBloku.toISOString();
    const datumKonecStr = konecBloku.toISOString();

    console.log(`🏒 HOKEJ SYNC: Kontroluji mantinel (${datumStartStr} až ${datumKonecStr})...`);

    const dnyKeStazeni = new Set();
    const zapasy = RAM_CENTRAL_MATCHES["Tipsport Extraliga"] || {};

    Object.values(zapasy).forEach(z => {
        if (!z.datum) return;
        const matchMs = Date.parse(z.datum);
        if (isNaN(matchMs)) return;

        // Kontrola, zda zápas spadá přesně do daného okna
        if (matchMs >= minTargetMs && matchMs <= maxTargetMs) {
            const matchDate = new Date(matchMs);
            const datumIso = matchDate.toISOString().split("T")[0];
            const matchKey = `${PL_NORM(z.domaci)} vs ${PL_NORM(z.hoste)}`;
            const uzMaKurz = RAM_CENTRAL_ODDS["Tipsport Extraliga"]?.[matchKey] || RAM_CENTRAL_ODDS["Tipsport Extraliga"]?.[z.id] || z.odds;

            if (!uzMaKurz) {
                const dayKey = `ice-hockey_${datumIso}`;
                if (!RAM_PROCESSED_ODDS_DAYS.has(dayKey)) {
                    dnyKeStazeni.add(datumIso);
                }
            }
        }
    });

    if (dnyKeStazeni.size === 0) {
        console.log(`🛡️ HOKEJ SYNC: Žádné chybějící dny kurzů pro Extraligu v daném okně. Přeskakuji API (0 requestů).`);
        return;
    }

    console.log(`🚀 HOKEJ SYNC: Stahuji kurzy pro ${dnyKeStazeni.size} hokejových dnů.`);

    let celkemNaparovano = 0;
    for (const datum of dnyKeStazeni) {
        celkemNaparovano += await stahniDenniKurzyRapidApi("ice-hockey", datum);
        RAM_PROCESSED_ODDS_DAYS.add(`ice-hockey_${datum}`);
    }

    await ulozProcessedDaysDoR2();

    if (celkemNaparovano > 0) {
        await ulozKurzyDoR2();
    }

    await planujRekonstrukciAgregatu();
}

// 🎛️ GLOBÁLNÍ DYNAMICKÁ KONFIGURACE (Ovládaná ze Super Admin panelu přes Firestore)
const RAM_BOT_CONFIG = {
    active: true,
    liveInterval: 1,
    waitInterval: 10
};

// Slovník pro autonomní překlad týmů ze sportovního API
const slovnikTymu = {
    "Czech Republic": "Česko", "Czechia": "Česko", "Mexico": "Mexiko",
    "South Korea": "Jižní Korea", "Korea Republic": "Jižní Korea", "South Africa": "JAR",
    "Bosnia and Herzegovina": "Bosna", "Bosnia": "Bosna", "Bosnia-Herzegovina": "Bosna",
    "Canada": "Kanada", "Qatar": "Katar", "Switzerland": "Švýcarsko",
    "Brazil": "Brazílie", "Haiti": "Haiti", "Morocco": "Maroko", "Scotland": "Skotsko",
    "Australia": "Austrálie", "Panama": "Panama", "Paraguay": "Paraguay", "Turkey": "Turecko", "Türkiye": "Turecko",
    "USA": "USA", "United States": "USA", "Curaçao": "Curaçao", "Curacao": "Curaçao",
    "Ecuador": "Ekvádor", "Germany": "Německo", "Ivory Coast": "Pob. slonoviny", "Côte d'Ivoire": "Pob. slonoviny",
    "Japan": "Japonsko", "Netherlands": "Nizozemsko", "Sweden": "Švédsko", "Tunisia": "Tunisko",
    "Belgium": "Belgie", "Egypt": "Egypt", "Iran": "Írán", "New Zealand": "Nový Zéland",
    "Cape Verde": "Kapverdy", "Cabo Verde": "Kapverdy", "Cape Verde Islands": "Kapverdy",
    "Saudi Arabia": "Saúdská Arábie", "Spain": "Španělsko", "Uruguay": "Uruguay",
    "France": "Francie", "Iraq": "Irák", "Norway": "Norsko", "Senegal": "Senegal",
    "Algeria": "Alžírsko", "Argentina": "Argentina", "Austria": "Rakousko", "Jordan": "Jordánsko",
    "Portugal": "Portugalsko", "Uzbekistan": "Uzbekistán", "Colombia": "Kolumbie",
    "DR Congo": "Kongo", "Congo DR": "Kongo", "Croatia": "Chorvatsko", "England": "Anglie",
    "Ghana": "Ghana",
    // ⚽ CHANCE LIGA - KRÁTKÉ NÁZVY
    "Sparta Prague": "Sparta", "AC Sparta Praha": "Sparta", "Sparta Praha": "Sparta",
    "Slavia Prague": "Slavia", "SK Slavia Praha": "Slavia", "Slavia Praha": "Slavia",
    "Viktoria Plzen": "Plzeň", "FC Viktoria Plzeň": "Plzeň", "Viktoria Plzeň": "Plzeň",
    "Banik Ostrava": "Ostrava", "FC Baník Ostrava": "Ostrava", "Baník Ostrava": "Ostrava",
    "Sigma Olomouc": "Olomouc", "SK Sigma Olomouc": "Olomouc",
    "Slovan Liberec": "Liberec", "FC Slovan Liberec": "Liberec",
    "Mlada Boleslav": "Ml. Boleslav", "FK Mladá Boleslav": "Ml. Boleslav", "Mladá Boleslav": "Ml. Boleslav",
    "Hradec Kralove": "Hr. Králové", "FC Hradec Králové": "Hr. Králové", "Hradec Králové": "Hr. Králové",
    "Slovacko": "Slovácko", "1.FC Slovácko": "Slovácko", "1. FC Slovácko": "Slovácko",
    "Teplice": "Teplice", "FK Teplice": "Teplice",
    "Pardubice": "Pardubice", "FK Pardubice": "Pardubice",
    "Jablonec": "Jablonec", "FK Jablonec": "Jablonec",
    "Zlin": "Zlín", "FC Zlín": "Zlín", "Fastav Zlín": "Zlín",
    "Bohemians 1905": "Bohemians", "Bohemians Praha 1905": "Bohemians",
    "Zbrojovka Brno": "Zbrojovka Brno", "FC Zbrojovka Brno": "Zbrojovka Brno", "FC Brno": "Zbrojovka Brno",
    "Artis Brno": "Artis Brno", "SK Artis Brno": "Artis Brno", "SK Líšeň": "Artis Brno", "SK Lisen": "Artis Brno",
    // 🏴󠁧󠁢󠁥󠁮󠁧󠁿 PREMIER LEAGUE - KRÁTKÉ ČESKÉ NÁZVY
    "Arsenal FC": "Arsenal", "Arsenal": "Arsenal",
    "Aston Villa FC": "Aston Villa", "Aston Villa": "Aston Villa",
    "AFC Bournemouth": "Bournemouth", "Bournemouth": "Bournemouth",
    "Brentford FC": "Brentford", "Brentford": "Brentford",
    "Brighton & Hove Albion FC": "Brighton", "Brighton & Hove Albion": "Brighton", "Brighton and Hove Albion": "Brighton", "Brighton": "Brighton",
    "Chelsea FC": "Chelsea", "Chelsea": "Chelsea",
    "Coventry City FC": "Coventry", "Coventry City": "Coventry", "Coventry": "Coventry",
    "Crystal Palace FC": "Crystal Palace", "Crystal Palace": "Crystal Palace",
    "Everton FC": "Everton", "Everton": "Everton",
    "Fulham FC": "Fulham", "Fulham": "Fulham",
    "Hull City AFC": "Hull", "Hull City": "Hull", "Hull": "Hull",
    "Ipswich Town FC": "Ipswich", "Ipswich Town": "Ipswich", "Ipswich": "Ipswich",
    "Leeds United FC": "Leeds", "Leeds United": "Leeds", "Leeds": "Leeds",
    "Liverpool FC": "Liverpool", "Liverpool": "Liverpool",
    "Manchester City FC": "Man. City", "Manchester City": "Man. City",
    "Manchester United FC": "Man. United", "Manchester United": "Man. United",
    "Newcastle United FC": "Newcastle", "Newcastle United": "Newcastle", "Newcastle": "Newcastle",
    "Nottingham Forest FC": "Nottingham", "Nottingham Forest": "Nottingham", "Nottingham": "Nottingham",
    "Sunderland AFC": "Sunderland", "Sunderland": "Sunderland",
    "Tottenham Hotspur FC": "Tottenham", "Tottenham Hotspur": "Tottenham", "Tottenham": "Tottenham",
    // 🏒 TIPSPORT EXTRALIGA - KRÁTKÉ ČESKÉ NÁZVY S DIAKRITIKOU
    "HC Sparta Praha": "Sparta", "Sparta Praha": "Sparta", "Sparta": "Sparta",
    "HC Dynamo Pardubice": "Pardubice", "Dynamo Pardubice": "Pardubice", "Pardubice": "Pardubice",
    "HC Oceláři Třinec": "Třinec", "Oceláři Třinec": "Třinec", "HC Ocelari Trinec": "Třinec", "Ocelari Trinec": "Třinec", "Trinec": "Třinec", "Třinec": "Třinec",
    "HC VÍTKOVICE RIDERA": "Vítkovice", "HC Vitkovice Ridera": "Vítkovice", "HC VÍTKOVICE": "Vítkovice", "VITKOVICE": "Vítkovice", "HC Vitkovice": "Vítkovice", "HC Vítkovice": "Vítkovice", "Vitkovice": "Vítkovice", "Vítkovice": "Vítkovice",
    "Bílí Tygři Liberec": "Liberec", "Bili Tygri Liberec": "Liberec", "Liberec": "Liberec",
    "HC Kometa Brno": "Brno", "Kometa Brno": "Brno", "Brno": "Brno",
    "Mountfield HK": "Hr. Králové", "Mountfield Hradec Kralove": "Hr. Králové",
    "HC VERVA Litvínov": "Litvínov", "HC Verva Litvinov": "Litvínov", "Verva Litvinov": "Litvínov", "HC Litvinov": "Litvínov", "HC Litvínov": "Litvínov", "Litvinov": "Litvínov", "Litvínov": "Litvínov",
    "HC Olomouc": "Olomouc", "Olomouc": "Olomouc",
    "BK Mladá Boleslav": "Ml. Boleslav", "BK Mlada Boleslav": "Ml. Boleslav",
    "HC Škoda Plzeň": "Plzeň", "HC Skoda Plzen": "Plzeň", "Skoda Plzen": "Plzeň", "HC Plzen": "Plzeň", "HC Plzeň": "Plzeň", "Plzen": "Plzeň", "Plzeň": "Plzeň",
    "HC Energie Karlovy Vary": "K. Vary", "Energie Karlovy Vary": "K. Vary", "Karlovy Vary": "K. Vary",
    "Rytíři Kladno": "Kladno", "Rytiri Kladno": "Kladno", "Kladno": "Kladno",
    "Banes Motor České Budějovice": "Č. Budějovice", "HC Motor České Budějovice": "Č. Budějovice", "Motor České Budějovice": "Č. Budějovice", "Ceske Budejovice": "Č. Budějovice", "České Budějovice": "Č. Budějovice",
    // 🏆 LIGA MISTRŮ (UEFA CHAMPIONS LEAGUE)
    "Real Madrid CF": "Real Madrid", "Real Madrid": "Real Madrid",
    "FC Barcelona": "Barcelona", "Barcelona": "Barcelona",
    "FC Bayern München": "Bayern", "Bayern Munich": "Bayern", "Bayern München": "Bayern", "Bayern": "Bayern",
    "Paris Saint-Germain": "PSG", "Paris Saint Germain": "PSG", "Paris SG": "PSG", "PSG": "PSG",
    "FC Internazionale Milano": "Inter", "Inter Milan": "Inter", "Inter": "Inter",
    "Juventus FC": "Juventus", "Juventus": "Juventus",
    "AC Milan": "AC Milán", "Milan": "AC Milán",
    "Atalanta BC": "Atalanta", "Atalanta": "Atalanta",
    "Bologna FC 1909": "Bologna", "Bologna": "Bologna",
    "Borussia Dortmund": "Dortmund", "Bayer 04 Leverkusen": "Leverkusen", "Bayer Leverkusen": "Leverkusen", "Leverkusen": "Leverkusen",
    "RB Leipzig": "Lipsko", "RasenBallsport Leipzig": "Lipsko", "Stuttgart": "Stuttgart", "VfB Stuttgart": "Stuttgart",
    "Atlético Madrid": "Atlético", "Atletico Madrid": "Atlético", "Club Atlético de Madrid": "Atlético",
    "Girona FC": "Girona", "Girona": "Girona",
    "Sporting CP": "Sporting", "Sporting Lisbon": "Sporting", "Sporting Clube de Portugal": "Sporting",
    "SL Benfica": "Benfica", "Benfica": "Benfica",
    "Feyenoord Rotterdam": "Feyenoord", "Feyenoord": "Feyenoord",
    "PSV Eindhoven": "PSV", "PSV": "PSV",
    "Club Brugge KV": "Bruggy", "Club Brugge": "Bruggy", "Brugge": "Bruggy",
    "Celtic FC": "Celtic", "Celtic": "Celtic",
    "AS Monaco FC": "Monaco", "AS Monaco": "Monaco", "Monaco": "Monaco",
    "Stade Brestois 29": "Brest", "Stade Brestois": "Brest", "Brest": "Brest",
    "Lille OSC": "Lille", "Lille": "Lille",
    "SK Sturm Graz": "Sturm Graz", "Sturm Graz": "Sturm Graz",
    "FC Salzburg": "Salcburk", "Red Bull Salzburg": "Salcburk", "Salzburg": "Salcburk",
    "GNK Dinamo Zagreb": "Dinamo Záhřeb", "Dinamo Zagreb": "Dinamo Záhřeb",
    "FK Crvena Zvezda": "Crvena Zvezda", "Red Star Belgrade": "Crvena Zvezda",
    "ŠK Slovan Bratislava": "Slovan Bratislava", "Slovan Bratislava": "Slovan Bratislava",
    "BSC Young Boys": "Young Boys", "Young Boys": "Young Boys",
    "FC Shakhtar Donetsk": "Šachtar", "Shakhtar Donetsk": "Šachtar",
    // 🔍 OVĚŘENÉ DVOJICE ZE SOFASCORE API PRO LIGU MISTRŮ
    "FC Porto": "Porto", "Porto": "Porto",
    "Viking FK": "Viking", "Viking": "Viking",
    "SSC Napoli": "Napoli", "Napoli": "Napoli",
    "AS Roma": "Roma", "Roma": "Roma",
    "Sabah FK": "Sabah Baku", "Sabah": "Sabah Baku",
    "RC Lens": "Lens", "Lens": "Lens",
    "Olympique Lyonnais": "Lyon", "Lyon": "Lyon",
    "Royale Union Saint-Gilloise": "Union SG",
    "Olympiacos FC": "Olympiacos",
    "Bodø/Glimt": "Bodø/Glimt", "FK Bodø/Glimt": "Bodø/Glimt"
};

const PL_NORM = (str) => String(str || '').toLowerCase().trim();

// --- 🧮 VÝPOČET BODŮ ---
const vypocitejBodyZapasuLocal = (tipDomaci, tipHoste, realDomaci, realHoste, tipPostup, realPostup, isPlayoff, isTopMatch = false, leagueName = "DEFAULT") => {
    const tDom = parseInt(tipDomaci); const tHos = parseInt(tipHoste);
    const rDom = parseInt(realDomaci); const rHos = parseInt(realHoste);
    if (isNaN(tDom) || isNaN(tHos) || isNaN(rDom) || isNaN(rHos)) return 0;

    const pravidla = PRAVIDLA_LIG[leagueName] || PRAVIDLA_LIG["DEFAULT"];
    let ziskaneBody = 0;

    if (leagueName === "Tipsport Extraliga") {
        const jeTipRemiza = (tDom === tHos);
        const jeRealRemiza = (rDom === rHos);
        const trefilPostup = Boolean(tipPostup && realPostup && tipPostup === realPostup);

        if (jeTipRemiza && jeRealRemiza) {
            const jePresnaRemiza = (tDom === rDom && tHos === rHos);
            if (isTopMatch) {
                return jePresnaRemiza 
                    ? (trefilPostup ? 11 : 10)
                    : (trefilPostup ? 8 : 6);
            } else {
                return jePresnaRemiza
                    ? (trefilPostup ? 7 : 6)
                    : (trefilPostup ? 4 : 3);
            }
        } else if (!jeTipRemiza && !jeRealRemiza) {
            const presny = (tDom === rDom && tHos === rHos);
            const spravnaTendence = (tDom > tHos && rDom > rHos) || (tDom < tHos && rDom < rHos);
            if (presny) {
                return isTopMatch ? 10 : 5;
            } else if (spravnaTendence) {
                return isTopMatch ? 4 : 2;
            } else {
                return -1;
            }
        } else {
            return -1;
        }
    }

    if (tDom === rDom && tHos === rHos) {
        ziskaneBody = pravidla.presnyVysledek;
        if (isPlayoff && rDom === rHos && realPostup && tipPostup && tipPostup === realPostup) {
            ziskaneBody += pravidla.playoffBonus;
        }
    } else if (rDom === rHos && tDom === tHos) {
        ziskaneBody = pravidla.chytraTendence > 0 ? pravidla.chytraTendence : pravidla.zakladniTendence;
        if (isPlayoff && realPostup && tipPostup && tipPostup === realPostup) {
            ziskaneBody += pravidla.playoffBonus;
        }
    } else {
        const tipRozdil = tDom - tHos; const realRozdil = rDom - rHos;
        const spravnaTendence = (tipRozdil > 0 && realRozdil > 0) || (tipRozdil < 0 && realRozdil < 0);
        if (spravnaTendence) {
            const trefilGoly = (tDom === rDom || tHos === rHos);
            const trefilRozdil = (tipRozdil === realRozdil);
            if ((trefilGoly || trefilRozdil) && pravidla.chytraTendence > 0) {
                ziskaneBody = pravidla.chytraTendence;
            } else {
                ziskaneBody = pravidla.zakladniTendence;
            }
        } else if (pravidla.golUtechy > 0 && (tDom === rDom || tHos === rHos)) {
            ziskaneBody = pravidla.golUtechy;
        }
    }

    if (isTopMatch && pravidla.hasTopMatch && ziskaneBody > 0) {
        ziskaneBody *= (pravidla.topMatchMultiplier || 1);
    }

    return ziskaneBody;
};

// --- 📤 DISTRIBUČNÍ SYSTÉM PRO R2 UPLOAD ---
async function uploadToR2(leagueName, filename, jsonData) {
    const ligaKlic = String(leagueName).replace(/ /g, "_");
    const dynamicPath = `sezony/${SEZONA_ID}/${ligaKlic}/${filename}`;
    const bodyText = JSON.stringify(jsonData, null, 2);

    for (let pokus = 1; pokus <= 2; pokus++) {
        try {
            await r2Client.send(new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: dynamicPath,
                Body: bodyText,
                ContentType: "application/json"
            }));
            return;
        } catch (err) {
            if (pokus === 2) {
                console.error(`❌ Chyba distribuce souboru ${filename} (${leagueName}) do R2:`, err.message || err);
            }
        }
    }
}

// ⚡ ATOMICKÁ EXECUTION QUEUE: Zpracovává změny okamžitě a bezpečně bez prodlev
let isReconstructing = false;
let pendingRerun = false;
let pendingHistoryFlag = false;

async function planujRekonstrukciAgregatu(forceWriteHistory = false) {
    if (forceWriteHistory) pendingHistoryFlag = true;

    if (isReconstructing) {
        pendingRerun = true;
        return;
    }

    isReconstructing = true;
    try {
        do {
            pendingRerun = false;
            const writeHistory = pendingHistoryFlag;
            pendingHistoryFlag = false;
            await rekonstruujAgregatyVsechny(writeHistory);
        } while (pendingRerun);
    } catch (err) {
        console.error("❌ Chyba ve frontě přepočtu agregátů:", err);
    } finally {
        isReconstructing = false;
    }
}

// --- 📡 HYDRATACE A REAKTIVNÍ STREAMY ---
let jeInicializovano = false;

async function hydratujDataZFirestore() {
    console.log("👥 Jednorázově načítám uživatele, tipy a zápasy z databáze do RAM...");

    try {
        const configDoc = await db.collection("system").doc("bot_config").get();
        if (configDoc.exists) {
            const data = configDoc.data() || {};
            RAM_BOT_CONFIG.active = data.active !== undefined ? data.active : true;
            RAM_BOT_CONFIG.liveInterval = parseInt(data.liveInterval) || 1;
            RAM_BOT_CONFIG.waitInterval = parseInt(data.waitInterval) || 10;
        }
    } catch (e) {
        console.error("⚠️ Nelze načíst bot_config:", e);
    }

    const usersSnap = await db.collection("users").get();
    usersSnap.forEach(docSnap => {
        const uid = docSnap.id;
        const data = docSnap.data() || {};
        const maAktivniLigu = data.leagues && SEZNAM_LIG.some(l => data.leagues.includes(l));
        if (maAktivniLigu) {
            RAM_USERS_PROFILES[uid] = {
                email: (data.email || "").trim().toLowerCase(),
                nickname: data.nickname || (data.email || "").split('@')[0],
                leagues: data.leagues || []
            };
        }
    });

    const sezonySnap = await db.collectionGroup("sezony").get();
    sezonySnap.forEach(docSnap => {
        if (docSnap.id !== SEZONA_ID) return;
        if (!docSnap.ref.parent || !docSnap.ref.parent.parent) return;
        const uid = docSnap.ref.parent.parent.id;
        const sData = docSnap.data() || {};
        RAM_USERS_TIPS[uid] = sData.souteze || {};
    });

    // ⚡ R2-FIRST HYDRATACE: Zápasy načítáme bleskově z Cloudflare R2 (0 Firestore čtení)
    for (const leagueName of SEZNAM_LIG) {
        if (!RAM_CENTRAL_MATCHES[leagueName]) RAM_CENTRAL_MATCHES[leagueName] = {};
        const ligaKlic = String(leagueName).replace(/ /g, "_");
        const r2Key = `sezony/${SEZONA_ID}/${ligaKlic}/rozpis.json`;
        let nactenoZR2 = false;

        try {
            const res = await r2Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: r2Key }));
            const strData = await res.Body.transformToString();
            const json = JSON.parse(strData);
            if (json && json.zapasyMapa && typeof json.zapasyMapa === "object" && Object.keys(json.zapasyMapa).length > 0) {
                Object.entries(json.zapasyMapa).forEach(([mId, data]) => {
                    let isoDatum = data.datum || new Date().toISOString();
                    const jeHotovoNeboPoVykovu = (data.apiStatus === "FINISHED") || (data.vysledek_domaci !== undefined && data.vysledek_domaci !== null) || (new Date(isoDatum) <= new Date());
                    RAM_CENTRAL_MATCHES[leagueName][mId] = {
                        domaci: data.domaci || "Neznámý",
                        hoste: data.hoste || "Neznámý",
                        datum: isoDatum,
                        isPlayoff: data.isPlayoff !== undefined ? data.isPlayoff : false,
                        isTopMatch: data.isTopMatch !== undefined ? data.isTopMatch : false,
                        kolo: data.kolo || "Šampionát",
                        vysledek_domaci: data.vysledek_domaci !== undefined ? data.vysledek_domaci : undefined,
                        vysledek_hoste: data.vysledek_hoste !== undefined ? data.vysledek_hoste : undefined,
                        apiStatus: data.apiStatus || "SCHEDULED",
                        postup: data.postup || "",
                        odds: data.odds || undefined,
                        spyUploaded: jeHotovoNeboPoVykovu,
                        spyR2Synced: jeHotovoNeboPoVykovu
                    };
                });
                console.log(`📦 R2 HYDRATACE [${leagueName}]: Načteno ${Object.keys(json.zapasyMapa).length} zápasů z R2 (0 Firestore čtení).`);
                nactenoZR2 = true;
            }
        } catch (r2Err) {}

        if (!nactenoZR2) {
            console.log(`⚠️ FIRESTORE FALLBACK [${leagueName}]: rozpis.json na R2 zatím neexistuje, stahuji z Firestore...`);
            const zapasySnap = await db.collection("ligy").doc(leagueName).collection("sezony").doc(SEZONA_ID).collection("zapasy").get();
            zapasySnap.forEach(docSnap => {
                const matchId = docSnap.id;
                const data = docSnap.data() || {};
                let isoDatum = new Date().toISOString();
                if (data.datum) {
                    isoDatum = typeof data.datum.toDate === 'function' ? data.datum.toDate().toISOString() : new Date(data.datum).toISOString();
                }
                const jeHotovoNeboPoVykovu = (data.apiStatus === "FINISHED") || (data.vysledek_domaci !== undefined && data.vysledek_domaci !== null) || (new Date(isoDatum) <= new Date());

                RAM_CENTRAL_MATCHES[leagueName][matchId] = {
                    domaci: data.domaci || "Neznámý",
                    hoste: data.hoste || "Neznámý",
                    datum: isoDatum,
                    isPlayoff: data.isPlayoff !== undefined ? data.isPlayoff : false,
                    isTopMatch: data.isTopMatch !== undefined ? data.isTopMatch : false,
                    kolo: data.kolo || "Šampionát",
                    vysledek_domaci: data.vysledek_domaci !== undefined ? data.vysledek_domaci : undefined,
                    vysledek_hoste: data.vysledek_hoste !== undefined ? data.vysledek_hoste : undefined,
                    apiStatus: data.apiStatus || "SCHEDULED",
                    postup: data.postup || "",
                    odds: data.odds || undefined,
                        spyUploaded: jeHotovoNeboPoVykovu,
                        spyR2Synced: jeHotovoNeboPoVykovu
                    };
            });
        }
    }

    console.log("🚀 Všechna data jsou kompletně v RAM. Spouštím rychlou startovní synchronizaci...");
    await rekonstruujAgregatyVsechny(false);
    jeInicializovano = true;
    console.log("✅ Úvodní synchronizace hotova bez zbytečného přepisování historie. Zapínám hlídače.");
}

function zapniReaktivniSluchatka() {
    db.collection("system").doc("bot_config").onSnapshot(doc => {
        if (doc.exists) {
            const data = doc.data() || {};
            RAM_BOT_CONFIG.active = data.active !== undefined ? data.active : true;
            RAM_BOT_CONFIG.liveInterval = parseInt(data.liveInterval) || 1;
            RAM_BOT_CONFIG.waitInterval = parseInt(data.waitInterval) || 10;
        }
    }, err => console.error("❌ Chyba streamu ovládání bota:", err));

    db.collection("users").onSnapshot(snapshot => {
        if (!jeInicializovano) return;
        snapshot.docChanges().forEach(change => {
            const uid = change.doc.id;
            const data = change.doc.data() || {};
            if (change.type === "removed") {
                delete RAM_USERS_PROFILES[uid];
            } else {
                const maAktivniLigu = data.leagues && SEZNAM_LIG.some(l => data.leagues.includes(l));
                if (maAktivniLigu) {
                    RAM_USERS_PROFILES[uid] = {
                        email: (data.email || "").trim().toLowerCase(),
                        nickname: data.nickname || (data.email || "").split('@')[0],
                        leagues: data.leagues || []
                    };
                } else {
                    delete RAM_USERS_PROFILES[uid];
                }
            }
        });
        planujRekonstrukciAgregatu();
    }, err => console.error("❌ Chyba streamu uživatelů:", err));

    db.collectionGroup("sezony").onSnapshot(snapshot => {
        if (!jeInicializovano) return;
        snapshot.docChanges().forEach(change => {
            if (change.doc.id !== SEZONA_ID) return;
            if (!change.doc.ref.parent || !change.doc.ref.parent.parent) return;
            const uid = change.doc.ref.parent.parent.id;
            if (change.type === "removed") {
                delete RAM_USERS_TIPS[uid];
            } else {
                const sData = change.doc.data() || {};
                RAM_USERS_TIPS[uid] = sData.souteze || {};
            }
        });
        planujRekonstrukciAgregatu(true);
    }, err => console.error("❌ Chyba streamu sezón:", err));

    SEZNAM_LIG.forEach(leagueName => {
        db.collection("ligy").doc(leagueName).collection("sezony").doc(SEZONA_ID).collection("zapasy").onSnapshot(snapshot => {
            if (!jeInicializovano || RAM_IS_SYNCING) return;
            let realnaZmena = false;

            snapshot.docChanges().forEach(change => {
                const matchId = change.doc.id;
                const data = change.doc.data() || {};
                if (change.type === "removed") {
                    if (RAM_CENTRAL_MATCHES[leagueName]?.[matchId]) {
                        delete RAM_CENTRAL_MATCHES[leagueName][matchId];
                        realnaZmena = true;
                    }
                } else {
                    if (!RAM_CENTRAL_MATCHES[leagueName]) RAM_CENTRAL_MATCHES[leagueName] = {};
                    const stary = RAM_CENTRAL_MATCHES[leagueName][matchId] || {};
                    let isoDatum = stary.datum || new Date().toISOString();
                    if (data.datum) {
                        isoDatum = typeof data.datum.toDate === 'function' ? data.datum.toDate().toISOString() : new Date(data.datum).toISOString();
                    }

                    // 🔍 RAM DIFF: Porovnáme nová data s RAM. Pokud jsou 100% shodná (botův vlastní zápis), ignorujeme!
                    const jeShodne = (
                        stary.domaci === (data.domaci || stary.domaci) &&
                        stary.hoste === (data.hoste || stary.hoste) &&
                        stary.datum === isoDatum &&
                        stary.kolo === (data.kolo || stary.kolo) &&
                        stary.isPlayoff === (data.isPlayoff !== undefined ? data.isPlayoff : (stary.isPlayoff || false)) &&
                        stary.isTopMatch === (data.isTopMatch !== undefined ? data.isTopMatch : (stary.isTopMatch || false)) &&
                        stary.vysledek_domaci === (data.vysledek_domaci !== undefined ? data.vysledek_domaci : stary.vysledek_domaci) &&
                        stary.vysledek_hoste === (data.vysledek_hoste !== undefined ? data.vysledek_hoste : stary.vysledek_hoste) &&
                        stary.apiStatus === (data.apiStatus || stary.apiStatus || "SCHEDULED") &&
                        stary.postup === (data.postup || stary.postup || "")
                    && JSON.stringify(stary.odds || null) === JSON.stringify(data.odds || null)
                    );

                    if (!jeShodne) {
                        realnaZmena = true;
                        const finalOdds = data.odds || stary.odds || undefined;
                        RAM_CENTRAL_MATCHES[leagueName][matchId] = {
                            domaci: data.domaci || stary.domaci || "Neznámý",
                            hoste: data.hoste || stary.hoste || "Neznámý",
                            datum: isoDatum,
                            isPlayoff: data.isPlayoff !== undefined ? data.isPlayoff : (stary.isPlayoff || false),
                            isTopMatch: data.isTopMatch !== undefined ? data.isTopMatch : (stary.isTopMatch || false),
                            kolo: data.kolo || stary.kolo || "Šampionát",
                            vysledek_domaci: data.vysledek_domaci !== undefined ? data.vysledek_domaci : stary.vysledek_domaci,
                            vysledek_hoste: data.vysledek_hoste !== undefined ? data.vysledek_hoste : stary.vysledek_hoste,
                            apiStatus: data.apiStatus || stary.apiStatus || "SCHEDULED",
                            postup: data.postup || stary.postup || "",
                            odds: finalOdds,
                            spyUploaded: stary.spyUploaded || false,
                            spyR2Synced: stary.spyR2Synced || false
                        };
                        if (finalOdds) {
                            if (!RAM_CENTRAL_ODDS[leagueName]) RAM_CENTRAL_ODDS[leagueName] = {};
                            RAM_CENTRAL_ODDS[leagueName][matchId] = finalOdds;
                        }
                    }
                }
            });

            if (realnaZmena) {
                console.log(`📡 ADMIN DETEKCE [${leagueName}]: Zaznamenána externí změna v databázi -> přepočítávám.`);
                planujRekonstrukciAgregatu();
            }
        }, err => console.error(`❌ Chyba streamu zápasů pro ${leagueName}:`, err));
    });
}

// --- 📡 GLOBÁLNÍ LIVE RADAR PRO MENU A KATALOG (0 FIRESTORE READS) ---
let RAM_LAST_LIVE_RADAR_STR = "";

async function aktualizujLiveRadarR2() {
    const radarData = {};
    SEZNAM_LIG.forEach(lName => {
        const zapasy = Object.values(RAM_CENTRAL_MATCHES[lName] || {});
        radarData[lName] = zapasy.some(z => z.apiStatus === "IN_PLAY" || z.apiStatus === "PAUSED");
    });

    const str = JSON.stringify(radarData);
    if (str !== RAM_LAST_LIVE_RADAR_STR) {
        RAM_LAST_LIVE_RADAR_STR = str;
        try {
            await r2Client.send(new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: `sezony/${SEZONA_ID}/live_radar.json`,
                Body: str,
                ContentType: "application/json",
                CacheControl: "public, max-age=5, must-revalidate"
            }));
        } catch (e) {
            console.error("❌ Selhalo uložení live_radar.json do R2:", e.message);
        }
    }
}

// --- 🧮 AGREGÁTOR PAMĚTI ---
async function rekonstruujAgregatyVsechny(forceWriteHistory = false) {
    for (const leagueName of SEZNAM_LIG) {
        await rekonstruujAgregatyProLigu(leagueName, forceWriteHistory);
    }
    await aktualizujLiveRadarR2();
}

// =========================================================================
// 🏴󠁧󠁢󠁥󠁮󠁧󠁿 PREMIER LEAGUE 2026/2027 - MATICE KOŠŮ A DERBY RIVALIT
// =========================================================================
const PL_BASKETS = {
    basket1: [
        "man city", "manchester city", "man. city", "mancity",
        "arsenal",
        "liverpool",
        "man united", "manchester united", "man. united", "man utd", "man. utd", "manunited",
        "aston villa", "villa",
        "chelsea"
    ],
    big5: [
        "man city", "manchester city", "man. city",
        "arsenal",
        "liverpool",
        "man united", "manchester united", "man. united", "man utd", "man. utd",
        "chelsea"
    ],
    basket2: [
        "newcastle", "newcastle united", "newcastle utd",
        "brighton", "brighton & hove albion", "brighton and hove albion",
        "tottenham", "tottenham hotspur", "spurs",
        "brentford",
        "crystal palace", "palace",
        "bournemouth", "afc bournemouth",
        "fulham"
    ],
    basket3: [
        "everton",
        "nottingham", "nottingham forest", "forest",
        "sunderland",
        "leeds", "leeds united", "leeds utd",
        "ipswich", "ipswich town",
        "coventry", "coventry city",
        "hull", "hull city"
    ]
};

const PL_DERBY_PAIRINGS = [
    ["arsenal", "tottenham hotspur"], ["arsenal", "tottenham"],
    ["chelsea", "tottenham hotspur"], ["chelsea", "tottenham"],
    ["liverpool", "everton"],
    ["newcastle united", "sunderland"], ["newcastle", "sunderland"],
    ["brighton & hove albion", "crystal palace"], ["brighton", "crystal palace"],
    ["brentford", "fulham"],
    ["chelsea", "fulham"],
    ["chelsea", "brentford"],
    ["leeds united", "hull city"], ["leeds", "hull"]
];

const PL_URCI_KOS = (tym) => {
    const t = PL_NORM(tym);
    if (PL_BASKETS.basket1.some(x => t.includes(x) || x.includes(t))) return 1;
    if (PL_BASKETS.basket2.some(x => t.includes(x) || x.includes(t))) return 2;
    return 3;
};

const RAM_PREV_TOP_MATCH_IDS = {};

// 🤖 AUTONOMNÍ GENERÁTOR TOP ZÁPASŮ
async function autoGenerujTopZapasyProLigu(leagueName, realLeagueData) {
    const pravidla = PRAVIDLA_LIG[leagueName];
    if (!pravidla || !pravidla.hasTopMatch) return;

    if (realLeagueData && realLeagueData.hasTopMatch === false) return;

    const centralMatches = RAM_CENTRAL_MATCHES[leagueName] || {};
    const zapasyPole = Object.entries(centralMatches).map(([id, z]) => ({ ...z, id }));
    if (zapasyPole.length === 0) return;

    const kolaMap = {};
    zapasyPole.forEach(z => {
        const k = String(z.kolo || "Šampionát").trim();
        if (!kolaMap[k]) kolaMap[k] = [];
        kolaMap[k].push(z);
    });

    const seznamKol = Object.keys(kolaMap);
    const totalRounds = seznamKol.length;

    let plnePokryto = true;
    for (const [koloNazev, zapasyVKole] of Object.entries(kolaMap)) {
        const topInRound = zapasyVKole.filter(z => z.isTopMatch);
        if (topInRound.length !== 1) {
            plnePokryto = false;
            break;
        }
    }

    if (plnePokryto) return;

    if (leagueName === "Premier League") {
        console.log(`⚡ BOT DAEMON [${leagueName}]: Generuji neprůstřelný rozpis TOP zápasů (${totalRounds} kol)...`);

        const prevProposalIds = RAM_PREV_TOP_MATCH_IDS[leagueName] || [];
        const bannedMatchIds = new Set();
        if (prevProposalIds.length > 0) {
            const shufflePrev = [...prevProposalIds].sort(() => Math.random() - 0.5);
            const banCount = Math.floor(Math.random() * 2) + 2;
            for (let b = 0; b < Math.min(banCount, shufflePrev.length); b++) {
                bannedMatchIds.add(shufflePrev[b]);
            }
        }

        const seedTeamBonus = {};
        zapasyPole.forEach(m => {
            const d = String(m.domaci || '').trim();
            const h = String(m.hoste || '').trim();
            if (!seedTeamBonus[d]) seedTeamBonus[d] = Math.random() * 45;
            if (!seedTeamBonus[h]) seedTeamBonus[h] = Math.random() * 45;
        });

        const calcMatchBaseScore = (z) => {
            const d = String(z.domaci || '').trim();
            const h = String(z.hoste || '').trim();
            const kosD = PL_URCI_KOS(d);
            const kosH = PL_URCI_KOS(h);

            let score = 0;
            if (kosD === kosH) {
                if (kosD === 1) score += 500;
                else if (kosD === 2) score += 300;
                else score += 150;
            } else if ((kosD === 2 && kosH === 3) || (kosD === 3 && kosH === 2)) {
                score += 40;
            } else {
                score += 10;
            }

            const jeDerby = PL_DERBY_PAIRINGS.some(pair => {
                const p0 = PL_NORM(pair[0]); const p1 = PL_NORM(pair[1]);
                const nd = PL_NORM(d); const nh = PL_NORM(h);
                return (nd.includes(p0) && nh.includes(p1)) || (nd.includes(p1) && nh.includes(p0));
            });
            if (jeDerby) score += 100;

            score += (seedTeamBonus[d] || 0) + (seedTeamBonus[h] || 0);
            return score;
        };

        const runTieredBottleneckPass = () => {
            const vybraneMapa = {};
            const tymCount = {};
            const tymPosledniKolo = {};
            const odehraneDvojice = new Set();
            let totalScore = 0;

            const roundData = seznamKol.map((roundName, rIdx) => {
                const matches = kolaMap[roundName] || [];
                const inBasketMatches = matches.filter(z => PL_URCI_KOS(z.domaci) === PL_URCI_KOS(z.hoste));
                return {
                    roundName,
                    rIdx,
                    strictCount: inBasketMatches.length,
                    allMatches: matches
                };
            });

            const prioritizedRounds = [...roundData].sort((a, b) => {
                if (a.strictCount !== b.strictCount) return a.strictCount - b.strictCount;
                return (b.rIdx - a.rIdx) + (Math.random() * 6 - 3);
            });

            for (const rInfo of prioritizedRounds) {
                const rIdx = rInfo.rIdx;
                const roundName = rInfo.roundName;
                const matches = rInfo.allMatches;
                let vybranyZapas = null;

                for (let tier = 1; tier <= 4; tier++) {
                    let bestMatch = null;
                    let bestVal = -Infinity;

                    for (const z of matches) {
                        if (bannedMatchIds.has(z.id) && tier < 4) continue;

                        const d = String(z.domaci || '').trim();
                        const h = String(z.hoste || '').trim();
                        const kosD = PL_URCI_KOS(d);
                        const kosH = PL_URCI_KOS(h);
                        const dvojiceKlic = [PL_NORM(d), PL_NORM(h)].sort().join(' vs ');

                        const cD = tymCount[d] || 0;
                        const cH = tymCount[h] || 0;

                        if ((kosD === 1 && kosH === 3) || (kosD === 3 && kosH === 1)) continue;
                        if (cD >= 4 || cH >= 4) continue;
                        if (odehraneDvojice.has(dvojiceKlic)) continue;

                        if (tier === 1) {
                            if (kosD !== kosH) continue;
                            if (tymPosledniKolo[d] !== undefined && Math.abs(rIdx - tymPosledniKolo[d]) < 3) continue;
                            if (tymPosledniKolo[h] !== undefined && Math.abs(rIdx - tymPosledniKolo[h]) < 3) continue;
                        } else if (tier === 2) {
                            if (kosD !== kosH) continue;
                            if (tymPosledniKolo[d] !== undefined && Math.abs(rIdx - tymPosledniKolo[d]) < 2) continue;
                            if (tymPosledniKolo[h] !== undefined && Math.abs(rIdx - tymPosledniKolo[h]) < 2) continue;
                        } else if (tier === 3) {
                            if (kosD === 1 || kosH === 1) continue;
                            if (!((kosD === 2 && kosH === 3) || (kosD === 3 && kosH === 2))) continue;
                            if (tymPosledniKolo[d] !== undefined && Math.abs(rIdx - tymPosledniKolo[d]) < 2) continue;
                            if (tymPosledniKolo[h] !== undefined && Math.abs(rIdx - tymPosledniKolo[h]) < 2) continue;
                        } else if (tier === 4) {
                            if (tymPosledniKolo[d] !== undefined && Math.abs(rIdx - tymPosledniKolo[d]) < 1) continue;
                            if (tymPosledniKolo[h] !== undefined && Math.abs(rIdx - tymPosledniKolo[h]) < 1) continue;
                        }

                        let score = calcMatchBaseScore(z);
                        if (kosD === 1 && cD < 4) score += (4 - cD) * 100;
                        if (kosH === 1 && cH < 4) score += (4 - cH) * 100;
                        if (cD < 3) score += (3 - cD) * 50;
                        if (cH < 3) score += (3 - cH) * 50;
                        score += Math.random() * 30;

                        if (score > bestVal) {
                            bestVal = score;
                            bestMatch = z;
                        }
                    }

                    if (bestMatch) {
                        vybranyZapas = bestMatch;
                        break;
                    }
                }

                if (vybranyZapas) {
                    const d = String(vybranyZapas.domaci || '').trim();
                    const h = String(vybranyZapas.hoste || '').trim();
                    const dvojiceKlic = [PL_NORM(d), PL_NORM(h)].sort().join(' vs ');

                    vybraneMapa[roundName] = vybranyZapas.id;
                    tymCount[d] = (tymCount[d] || 0) + 1;
                    tymCount[h] = (tymCount[h] || 0) + 1;
                    tymPosledniKolo[d] = rIdx;
                    tymPosledniKolo[h] = rIdx;
                    odehraneDvojice.add(dvojiceKlic);
                    totalScore += calcMatchBaseScore(vybranyZapas);
                }
            }

            PL_BASKETS.basket1.forEach(b1Tym => {
                const realKey = Object.keys(tymCount).find(k => PL_NORM(k).includes(b1Tym) || b1Tym.includes(PL_NORM(k)));
                const cnt = realKey ? tymCount[realKey] : 0;
                if (cnt === 4) totalScore += 5000;
                else totalScore -= Math.abs(4 - cnt) * 20000;
            });

            Object.values(tymCount).forEach(cnt => {
                if (cnt >= 3 && cnt <= 4) totalScore += 1000;
                else if (cnt < 3) totalScore -= (3 - cnt) * 10000;
                else if (cnt > 4) totalScore -= (cnt - 4) * 30000;
            });

            return { mapa: vybraneMapa, score: totalScore };
        };

        let bestResult = null;
        let maxScore = -Infinity;

        for (let sim = 0; sim < 300; sim++) {
            const res = runTieredBottleneckPass();
            if (res && res.score > maxScore && Object.keys(res.mapa).length === totalRounds) {
                maxScore = res.score;
                bestResult = res;
            }
        }

        if (bestResult && bestResult.mapa) {
            const selectedIds = new Set(Object.values(bestResult.mapa));
            RAM_PREV_TOP_MATCH_IDS[leagueName] = Array.from(selectedIds);

            for (const match of zapasyPole) {
                const statusChceTop = selectedIds.has(match.id);
                if (match.isTopMatch !== statusChceTop) {
                    match.isTopMatch = statusChceTop;
                    if (RAM_CENTRAL_MATCHES[leagueName][match.id]) {
                        RAM_CENTRAL_MATCHES[leagueName][match.id].isTopMatch = statusChceTop;
                    }
                    try {
                        await db.collection("ligy").doc(leagueName)
                            .collection("sezony").doc(SEZONA_ID)
                            .collection("zapasy").doc(match.id)
                            .set({ isTopMatch: statusChceTop }, { merge: true });
                    } catch (e) {
                        console.error(`❌ Selhal zápis TOP zápasu v bot.mjs pro ${match.id}:`, e);
                    }
                }
            }
            console.log(`✅ BOT DAEMON [${leagueName}]: Rozpis TOP zápasů úspěšně nastaven.`);
            return;
        }
    }

    // Generická pojistka pro ostatní ligy
    const DERBY_SLAGRY = [
        "Sparta-Slavia", "Slavia-Sparta", "Plzeň-Sparta", "Sparta-Plzeň", "Slavia-Plzeň", "Plzeň-Slavia"
    ];

    const topUcastTymu = {};
    zapasyPole.forEach(z => {
        if (z.isTopMatch) {
            topUcastTymu[z.domaci] = (topUcastTymu[z.domaci] || 0) + 1;
            topUcastTymu[z.hoste] = (topUcastTymu[z.hoste] || 0) + 1;
        }
    });

    const spocitejSkoreZapasu = (m) => {
        let skore = 100;
        const ucastDom = topUcastTymu[m.domaci] || 0;
        const ucastHos = topUcastTymu[m.hoste] || 0;
        skore -= (ucastDom + ucastHos) * 25;
        const dvojice = `${m.domaci}-${m.hoste}`;
        if (DERBY_SLAGRY.some(d => d.toLowerCase() === dvojice.toLowerCase())) {
            skore += 40;
        }
        return skore;
    };

    for (const [koloNazev, zapasyVKole] of Object.entries(kolaMap)) {
        const topZapasyVKole = zapasyVKole.filter(z => z.isTopMatch);

        if (topZapasyVKole.length > 1) {
            topZapasyVKole.sort((a, b) => spocitejSkoreZapasu(b) - spocitejSkoreZapasu(a));
            const prebyvajici = topZapasyVKole.slice(1);

            for (const zPrebyvajici of prebyvajici) {
                if (zPrebyvajici.isTopMatch) {
                    zPrebyvajici.isTopMatch = false;
                    if (RAM_CENTRAL_MATCHES[leagueName][zPrebyvajici.id]) {
                        RAM_CENTRAL_MATCHES[leagueName][zPrebyvajici.id].isTopMatch = false;
                    }
                    try {
                        await db.collection("ligy").doc(leagueName)
                            .collection("sezony").doc(SEZONA_ID)
                            .collection("zapasy").doc(zPrebyvajici.id)
                            .set({ isTopMatch: false }, { merge: true });
                    } catch (e) {}
                }
            }
            continue;
        }

        if (topZapasyVKole.length === 1) continue;

        const neodehrane = zapasyVKole.filter(z => z.vysledek_domaci === undefined && z.apiStatus !== "IN_PLAY" && z.apiStatus !== "PAUSED");
        if (neodehrane.length === 0) continue;

        let nejlepsiZapas = null;
        let nejvyssiSkore = -Infinity;

        neodehrane.forEach(match => {
            const skore = spocitejSkoreZapasu(match);
            if (skore > nejvyssiSkore) {
                nejvyssiSkore = skore;
                nejlepsiZapas = match;
            }
        });

        if (nejlepsiZapas && !nejlepsiZapas.isTopMatch) {
            nejlepsiZapas.isTopMatch = true;
            if (RAM_CENTRAL_MATCHES[leagueName][nejlepsiZapas.id]) {
                RAM_CENTRAL_MATCHES[leagueName][nejlepsiZapas.id].isTopMatch = true;
            }

            try {
                await db.collection("ligy").doc(leagueName)
                    .collection("sezony").doc(SEZONA_ID)
                    .collection("zapasy").doc(nejlepsiZapas.id)
                    .set({ isTopMatch: true }, { merge: true });
            } catch (e) {
                console.error(`❌ Selhal automatický zápis TOP zápasu pro ${nejlepsiZapas.id}:`, e);
            }
        }
    }
}

// 💡 SPOLEČNÝ ANALYTICKÝ MOZEK RADARU
function spoctiRadarStatistikyBot(centralMatches, uzivateleProfily, uzivateleTipy, leagueName) {
    const ligaKlic = String(leagueName).replace(/ /g, "_");
    const zapasyPole = Object.entries(centralMatches).map(([id, z]) => ({ ...z, id }));
    const odehraneZapasy = zapasyPole.filter(z => 
        z.vysledek_domaci !== undefined && z.vysledek_domaci !== null && 
        z.apiStatus !== "IN_PLAY" && z.apiStatus !== "PAUSED"
    );

    if (odehraneZapasy.length === 0) {
        return {
            totalniVybuchy: [],
            vlciSamotari: [],
            zlatyDul: null,
            stedrostKlubu: [],
            nejcastejsiTip: "–",
            nejcastejsiTipPct: 0,
            nejcastejsiVysledek: "–",
            nejcastejsiVysledekPct: 0,
            uspesnostTendencePct: 0,
            uspesnostPresnePct: 0,
            smolarSezony: null,
            hrdinaSezony: null
        };
    }

    const totalniVybuchy = [];
    const vlciSamotari = [];
    let zlatyDul = null;
    let maxRozdanoBodu = -1;

    const klubyStats = {};
    const cetnostTipu = {};
    const cetnostVysledku = {};
    const smolariMap = {};

    let celkemTipuSez = 0;
    let celkemSpravnychTendenci = 0;
    let celkemPresnychTref = 0;

    // ⏱️ PŘESNÉ CHRONOLOGICKÉ ŘAZENÍ ODEHRANÝCH ZÁPASŮ PODLE DATA A ČASU
    const odehraneZapasyChrono = [...odehraneZapasy].sort((a, b) => (Date.parse(a.datum) || 0) - (Date.parse(b.datum) || 0));

    // 🦸 VÝPOČET NEJDELŠÍ NESTANOVENÉ BODOVÉ ŠŇŮRY PRO KAŽDÉHO HRÁČE
    const streakMap = {};
    Object.keys(uzivateleProfily).forEach(uid => {
        const p = uzivateleProfily[uid];
        if (!p.leagues || !p.leagues.includes(leagueName)) return;

        const uSouteze = uzivateleTipy[uid] || {};
        const uSoutezData = uSouteze[ligaKlic] || {};
        const uTips = uSoutezData.tipy || {};

        let curStreak = 0;
        let curStreakPts = 0;
        let bestStreak = 0;
        let bestStreakPts = 0;

        odehraneZapasyChrono.forEach(zapas => {
            const uTip = uTips[zapas.id];
            if (!uTip || uTip.tip_domaci === undefined || uTip.tip_domaci === null || String(uTip.tip_domaci).trim() === '') {
                curStreak = 0;
                curStreakPts = 0;
                return;
            }

            const tDom = parseInt(uTip.tip_domaci);
            const tHos = parseInt(uTip.tip_hoste);
            const rDom = parseInt(zapas.vysledek_domaci);
            const rHos = parseInt(zapas.vysledek_hoste);

            if (isNaN(tDom) || isNaN(tHos) || isNaN(rDom) || isNaN(rHos)) {
                curStreak = 0;
                curStreakPts = 0;
                return;
            }

            const body = vypocitejBodyZapasuLocal(tDom, tHos, rDom, rHos, uTip.postup, zapas.postup, zapas.isPlayoff, zapas.isTopMatch, leagueName);

            if (body > 0) {
                curStreak++;
                curStreakPts += body;
                if (curStreak > bestStreak || (curStreak === bestStreak && curStreakPts > bestStreakPts)) {
                    bestStreak = curStreak;
                    bestStreakPts = curStreakPts;
                }
            } else {
                curStreak = 0;
                curStreakPts = 0;
            }
        });

        if (bestStreak > 0) {
            streakMap[uid] = { nick: p.nickname, streak: bestStreak, points: bestStreakPts };
        }
    });

    let hrdinaSezony = null;
    const allStreaks = Object.values(streakMap);
    if (allStreaks.length > 0) {
        const maxStreak = Math.max(...allStreaks.map(s => s.streak));
        if (maxStreak > 0) {
            const topStreakUsers = allStreaks.filter(s => s.streak === maxStreak);
            const maxPtsInStreak = Math.max(...topStreakUsers.map(s => s.points));
            const bestHeroes = topStreakUsers.filter(s => s.points === maxPtsInStreak);
            const heroNicks = bestHeroes.map(h => h.nick).join(", ");
            hrdinaSezony = {
                names: heroNicks,
                pocet: maxStreak,
                body: maxPtsInStreak
            };
        }
    }

    odehraneZapasy.forEach(zapas => {
        const rDom = parseInt(zapas.vysledek_domaci);
        const rHos = parseInt(zapas.vysledek_hoste);
        if (isNaN(rDom) || isNaN(rHos)) return;

        const vysledekStr = `${rDom} : ${rHos}`;
        cetnostVysledku[vysledekStr] = (cetnostVysledku[vysledekStr] || 0) + 1;

        let celkemBoduZapasu = 0;
        let presnychZasahu = 0;
        const hraciSBody = [];
        let tipovaloLidi = 0;

        const dNazev = zapas.domaci || "Domácí";
        const hNazev = zapas.hoste || "Hosté";

        if (!klubyStats[dNazev]) klubyStats[dNazev] = { body: 0, zapasu: 0, uspesne: 0, celkemTipu: 0 };
        if (!klubyStats[hNazev]) klubyStats[hNazev] = { body: 0, zapasu: 0, uspesne: 0, celkemTipu: 0 };
        klubyStats[dNazev].zapasu++;
        klubyStats[hNazev].zapasu++;

        Object.keys(uzivateleProfily).forEach(uid => {
            const p = uzivateleProfily[uid];
            if (!p.leagues || !p.leagues.includes(leagueName)) return;

            const uSouteze = uzivateleTipy[uid] || {};
            const uSoutezData = uSouteze[ligaKlic] || {};
            const uTip = uSoutezData.tipy ? uSoutezData.tipy[zapas.id] : null;

            if (!uTip || uTip.tip_domaci === undefined || uTip.tip_domaci === null || String(uTip.tip_domaci).trim() === '') return;

            const tDom = parseInt(uTip.tip_domaci);
            const tHos = parseInt(uTip.tip_hoste);
            if (isNaN(tDom) || isNaN(tHos)) return;

            tipovaloLidi++;
            celkemTipuSez++;

            const tipStr = `${tDom} : ${tHos}`;
            cetnostTipu[tipStr] = (cetnostTipu[tipStr] || 0) + 1;

            const body = vypocitejBodyZapasuLocal(tDom, tHos, rDom, rHos, uTip.postup, zapas.postup, zapas.isPlayoff, zapas.isTopMatch, leagueName);

            klubyStats[dNazev].celkemTipu++;
            klubyStats[hNazev].celkemTipu++;

            const jePresny = (tDom === rDom && tHos === rHos && (!zapas.isPlayoff || rDom !== rHos || uTip.postup === zapas.postup));
            const jeTendence = (tDom > tHos && rDom > rHos) || (tDom < tHos && rDom < rHos) || (tDom === tHos && rDom === rHos);

            if (jePresny) celkemPresnychTref++;
            if (jeTendence) celkemSpravnychTendenci++;

            if (body > 0) {
                celkemBoduZapasu += body;
                hraciSBody.push({ uid, nick: p.nickname, body });
                klubyStats[dNazev].body += body;
                klubyStats[hNazev].body += body;
                klubyStats[dNazev].uspesne++;
                klubyStats[hNazev].uspesne++;
            }

            if (jePresny) {
                presnychZasahu++;
            } else {
                const rozdil = Math.abs(tDom - rDom) + Math.abs(tHos - rHos);
                if (rozdil === 1) {
                    smolariMap[uid] = (smolariMap[uid] || 0) + 1;
                }
            }
        });

        const zapasLabel = `${dNazev} ${rDom} : ${rHos} ${hNazev}`;
        const koloLabel = zapas.kolo || "Šampionát";

        if (tipovaloLidi > 0 && hraciSBody.length === 0) {
            totalniVybuchy.push({ zapas: zapasLabel, kolo: koloLabel, datum: zapas.datum });
        }

        if (tipovaloLidi > 1 && hraciSBody.length === 1) {
            vlciSamotari.push({ zapas: zapasLabel, kolo: koloLabel, hrac: hraciSBody[0].nick, body: hraciSBody[0].body, datum: zapas.datum });
        }

        if (celkemBoduZapasu > maxRozdanoBodu || (celkemBoduZapasu === maxRozdanoBodu && zlatyDul && presnychZasahu > zlatyDul.presnych)) {
            maxRozdanoBodu = celkemBoduZapasu;
            zlatyDul = { zapas: zapasLabel, kolo: koloLabel, rozdanoBodu: celkemBoduZapasu, presnych: presnychZasahu };
        }
    });

    const stedrostKlubu = Object.entries(klubyStats).map(([tym, d]) => ({
        tym: tym,
        prumerBodu: d.zapasu > 0 ? parseFloat((d.body / d.zapasu).toFixed(1)) : 0,
        uspesnost: d.celkemTipu > 0 ? Math.round((d.uspesne / d.celkemTipu) * 100) : 0,
        celkemBodu: d.body,
        zapasu: d.zapasu
    })).sort((a, b) => {
        if (b.prumerBodu !== a.prumerBodu) return b.prumerBodu - a.prumerBodu;
        return b.uspesnost - a.uspesnost;
    });

    const sortedTipy = Object.entries(cetnostTipu).sort((a, b) => b[1] - a[1]);
    const topTip = sortedTipy[0] ? sortedTipy[0][0] : "–";
    const topTipCount = sortedTipy[0] ? sortedTipy[0][1] : 0;
    const topTipPct = celkemTipuSez > 0 ? Math.round((topTipCount / celkemTipuSez) * 100) : 0;

    const sortedVysledky = Object.entries(cetnostVysledku).sort((a, b) => b[1] - a[1]);
    const topVysledek = sortedVysledky[0] ? sortedVysledky[0][0] : "–";
    const topVysledekCount = sortedVysledky[0] ? sortedVysledky[0][1] : 0;
    const topVysledekPct = odehraneZapasy.length > 0 ? Math.round((topVysledekCount / odehraneZapasy.length) * 100) : 0;

    let nejSmolarUid = null;
    let maxSmula = 0;
    Object.entries(smolariMap).forEach(([uid, count]) => {
        if (count > maxSmula) {
            maxSmula = count;
            nejSmolarUid = uid;
        }
    });

    return {
        totalniVybuchy: totalniVybuchy.reverse(),
        vlciSamotari: vlciSamotari.reverse(),
        zlatyDul: zlatyDul,
        stedrostKlubu: stedrostKlubu,
        nejcastejsiTip: topTip,
        nejcastejsiTipPct: topTipPct,
        nejcastejsiVysledek: topVysledek,
        nejcastejsiVysledekPct: topVysledekPct,
        uspesnostTendencePct: celkemTipuSez > 0 ? Math.round((celkemSpravnychTendenci / celkemTipuSez) * 100) : 0,
        uspesnostPresnePct: celkemTipuSez > 0 ? Math.round((celkemPresnychTref / celkemTipuSez) * 100) : 0,
        smolarSezony: nejSmolarUid ? { nick: uzivateleProfily[nejSmolarUid]?.nickname, pocet: maxSmula } : null,
        hrdinaSezony: hrdinaSezony
    };
}

async function rekonstruujAgregatyProLigu(leagueName, forceWriteHistory = false) {
    const ligaKlic = String(leagueName).replace(/ /g, "_");
    const centralMatches = RAM_CENTRAL_MATCHES[leagueName] || {};

    const leagueDoc = await db.collection("ligy").doc(leagueName).get().catch(() => null);
    const realLeagueData = leagueDoc && leagueDoc.exists ? leagueDoc.data() : null;

    await autoGenerujTopZapasyProLigu(leagueName, realLeagueData);

    const zebricekMapa = {};
    const mapaPrezdivek = {};

    const matchesList = Object.values(centralMatches);
    const isLeagueStarted = matchesList.some(z => {
        const startMs = Date.parse(z.datum);
        return (!isNaN(startMs) && startMs <= Date.now()) || z.vysledek_domaci !== undefined || z.apiStatus === "IN_PLAY" || z.apiStatus === "PAUSED" || z.apiStatus === "FINISHED";
    });

    Object.keys(RAM_USERS_PROFILES).forEach(uid => {
        const p = RAM_USERS_PROFILES[uid];
        if (!p.leagues || !p.leagues.includes(leagueName)) return;

        mapaPrezdivek[p.email] = p.nickname;
        mapaPrezdivek[uid] = p.nickname;
        zebricekMapa[uid] = {
            uid: uid, email: p.email, nickname: p.nickname, celkemBodu: 0, natipovaneVyhodnocene: 0, nenatipovaneVyhodnocene: 0, presneVysledkyCount: 0,
            celkemBoduLive: 0, natipovaneVyhodnoceneLive: 0, nenatipovaneVyhodnoceneLive: 0, presneVysledkyCountLive: 0,
            bodyPoKolech: {}, nejStrelec: '–', vitezMs: '–', nejKanadske: '–', nejviceBoduVKole: 0
        };

        const uSouteze = RAM_USERS_TIPS[uid] || {};
        const uSoutezData = uSouteze[ligaKlic] || { tipy: {}, bonusy: {} };

        if (isLeagueStarted) {
            zebricekMapa[uid].vitezMs = uSoutezData.bonusy?.vitez || '–';
            zebricekMapa[uid].nejStrelec = uSoutezData.bonusy?.strelec || '–';
            zebricekMapa[uid].nejKanadske = uSoutezData.bonusy?.kanadske || '–';
        } else {
            zebricekMapa[uid].vitezMs = '🔒 SKRYTO DO STARTU';
            zebricekMapa[uid].nejStrelec = '🔒 SKRYTO DO STARTU';
            zebricekMapa[uid].nejKanadske = '🔒 SKRYTO DO STARTU';
        }
    });

    if (realLeagueData && (realLeagueData.vitez || realLeagueData.strelec || realLeagueData.kanadske)) {
        const pravidlaLigi = PRAVIDLA_LIG[leagueName] || PRAVIDLA_LIG["DEFAULT"];
        Object.keys(zebricekMapa).forEach(uKey => {
            if (realLeagueData.vitez && zebricekMapa[uKey].vitezMs && zebricekMapa[uKey].vitezMs.toLowerCase() === realLeagueData.vitez.toLowerCase()) {
                zebricekMapa[uKey].celkemBodu += pravidlaLigi.bonusVitez || 0; 
                zebricekMapa[uKey].celkemBoduLive += pravidlaLigi.bonusVitez || 0;
            }
            if (realLeagueData.strelec && zebricekMapa[uKey].nejStrelec && zebricekMapa[uKey].nejStrelec.toLowerCase() === realLeagueData.strelec.toLowerCase()) {
                zebricekMapa[uKey].celkemBodu += pravidlaLigi.bonusStrelec || 0; 
                zebricekMapa[uKey].celkemBoduLive += pravidlaLigi.bonusStrelec || 0;
            }
            if (realLeagueData.kanadske && zebricekMapa[uKey].nejKanadske && zebricekMapa[uKey].nejKanadske.toLowerCase() === realLeagueData.kanadske.toLowerCase()) {
                zebricekMapa[uKey].celkemBodu += pravidlaLigi.bonusKanadskeBodovani || 0; 
                zebricekMapa[uKey].celkemBoduLive += pravidlaLigi.bonusKanadskeBodovani || 0;
            }
        });
    }

    let aktivniKolo = "1";
    const zapasySerazene = Object.values(centralMatches).sort((a, b) => new Date(a.datum) - new Date(b.datum));
    const liveNeboBudouci = zapasySerazene.find(z => z.apiStatus === "IN_PLAY" || z.apiStatus === "PAUSED" || new Date(z.datum) > new Date());
    if (liveNeboBudouci && liveNeboBudouci.kolo) {
        aktivniKolo = String(liveNeboBudouci.kolo).trim();
    } else if (zapasySerazene.length > 0) {
        aktivniKolo = String(zapasySerazene[zapasySerazene.length - 1].kolo || "1").trim();
    }

    let maxMoznychBoduZapasu = 0;
    const pravidlaLigi = PRAVIDLA_LIG[leagueName] || PRAVIDLA_LIG["DEFAULT"];
    Object.values(centralMatches).forEach(zapas => {
        const jeVyhodnoceny = (zapas.vysledek_domaci !== undefined && zapas.apiStatus !== "IN_PLAY" && zapas.apiStatus !== "PAUSED");
        const jeBežícíLive = (zapas.apiStatus === "IN_PLAY" || zapas.apiStatus === "PAUSED");
        if (jeVyhodnoceny || jeBežícíLive) {
            let maxB = pravidlaLigi.presnyVysledek;
            if (zapas.isPlayoff && zapas.vysledek_domaci === zapas.vysledek_hoste) maxB += pravidlaLigi.playoffBonus;
            if (zapas.isTopMatch && pravidlaLigi.hasTopMatch) maxB *= pravidlaLigi.topMatchMultiplier;
            maxMoznychBoduZapasu += maxB;
        }
    });

    Object.keys(zebricekMapa).forEach(uKey => {
        zebricekMapa[uKey].bodyPoKolechLive = {};
        zebricekMapa[uKey].bodyZapasuCelkem = 0;
        zebricekMapa[uKey].bodyZapasuCelkemLive = 0;
    });

    Object.keys(centralMatches).forEach(matchId => {
        const zapas = centralMatches[matchId];
        const jeVyhodnoceny = (zapas.vysledek_domaci !== undefined && zapas.apiStatus !== "IN_PLAY" && zapas.apiStatus !== "PAUSED");
        const jeBežícíLive = (zapas.apiStatus === "IN_PLAY" || zapas.apiStatus === "PAUSED");
        const jeLiveNeboVyhodnoceny = (zapas.vysledek_domaci !== undefined) || jeBežícíLive;

        const vDomaci = zapas.vysledek_domaci !== undefined && zapas.vysledek_domaci !== null ? zapas.vysledek_domaci : 0;
        const vHoste = zapas.vysledek_hoste !== undefined && zapas.vysledek_hoste !== null ? zapas.vysledek_hoste : 0;

        Object.keys(RAM_USERS_PROFILES).forEach(uid => {
            if (!zebricekMapa[uid]) return;

            const uSouteze = RAM_USERS_TIPS[uid] || {};
            const uSoutezData = uSouteze[ligaKlic] || { tipy: {} };
            const uTip = uSoutezData.tipy ? uSoutezData.tipy[matchId] : null;

            if (jeVyhodnoceny) {
                let bodyZapasu = 0;
                if (uTip) {
                    bodyZapasu = vypocitejBodyZapasuLocal(uTip.tip_domaci, uTip.tip_hoste, zapas.vysledek_domaci, zapas.vysledek_hoste, uTip.postup, zapas.postup, zapas.isPlayoff, zapas.isTopMatch, leagueName);
                    zebricekMapa[uid].celkemBodu += bodyZapasu; zebricekMapa[uid].natipovaneVyhodnocene++;
                    
                    const tD = parseInt(uTip.tip_domaci); const tH = parseInt(uTip.tip_hoste);
                    const rD = parseInt(zapas.vysledek_domaci); const rH = parseInt(zapas.vysledek_hoste);
                    
                    const jePresny = tD === rD && tH === rH && (!zapas.isPlayoff || rD !== rH || uTip.postup === zapas.postup);
                    const jeTendence = (tD > tH && rD > rH) || (tD < tH && rD < rH) || (tD === tH && rD === rH);

                    if (jePresny) {
                        zebricekMapa[uid].presneVysledkyCount++;
                        if (zapas.isTopMatch) zebricekMapa[uid].presneTopMatchesCount = (zebricekMapa[uid].presneTopMatchesCount || 0) + 1;
                    }
                    if (jeTendence) {
                        zebricekMapa[uid].spravneTendenceCount = (zebricekMapa[uid].spravneTendenceCount || 0) + 1;
                    }
                } else {
                    bodyZapasu = pravidlaLigi.penaltyNenatipovano || 0;
                    zebricekMapa[uid].celkemBodu += bodyZapasu;
                    zebricekMapa[uid].nenatipovaneVyhodnocene++;
                }
                zebricekMapa[uid].bodyZapasuCelkem += bodyZapasu;
                if (zapas.kolo) {
                    const klicKola = String(zapas.kolo).trim();
                    if (zebricekMapa[uid].bodyPoKolech[klicKola] === undefined) zebricekMapa[uid].bodyPoKolech[klicKola] = 0;
                    zebricekMapa[uid].bodyPoKolech[klicKola] += bodyZapasu;
                }
            }

            if (jeLiveNeboVyhodnoceny) {
                let bodyZapasuLive = 0;
                if (uTip) {
                    bodyZapasuLive = vypocitejBodyZapasuLocal(uTip.tip_domaci, uTip.tip_hoste, vDomaci, vHoste, uTip.postup, zapas.postup, zapas.isPlayoff, zapas.isTopMatch, leagueName);
                    zebricekMapa[uid].celkemBoduLive += bodyZapasuLive; zebricekMapa[uid].natipovaneVyhodnoceneLive++;
                    
                    const tD = parseInt(uTip.tip_domaci); const tH = parseInt(uTip.tip_hoste);
                    const rDLive = parseInt(vDomaci); const rHLive = parseInt(vHoste);

                    const jePresnyLive = tD === rDLive && tH === rHLive && (!zapas.isPlayoff || rDLive !== rHLive || uTip.postup === zapas.postup);
                    const jeTendenceLive = (tD > tH && rDLive > rHLive) || (tD < tH && rDLive < rHLive) || (tD === tH && rDLive === rHLive);

                    if (jePresnyLive) {
                        zebricekMapa[uid].presneVysledkyCountLive++;
                        if (zapas.isTopMatch) zebricekMapa[uid].presneTopMatchesCountLive = (zebricekMapa[uid].presneTopMatchesCountLive || 0) + 1;
                    }
                    if (jeTendenceLive) {
                        zebricekMapa[uid].spravneTendenceCountLive = (zebricekMapa[uid].spravneTendenceCountLive || 0) + 1;
                    }
                } else {
                    bodyZapasuLive = pravidlaLigi.penaltyNenatipovano || 0;
                    zebricekMapa[uid].celkemBoduLive += bodyZapasuLive;
                    zebricekMapa[uid].nenatipovaneVyhodnoceneLive++;
                }
                zebricekMapa[uid].bodyZapasuCelkemLive += bodyZapasuLive;
                if (zapas.kolo) {
                    const klicKola = String(zapas.kolo).trim();
                    if (zebricekMapa[uid].bodyPoKolechLive[klicKola] === undefined) zebricekMapa[uid].bodyPoKolechLive[klicKola] = 0;
                    zebricekMapa[uid].bodyPoKolechLive[klicKola] += bodyZapasuLive;
                }
            }
        });
    });

    const kolaZapasyMap = {};
    Object.entries(centralMatches).forEach(([mId, z]) => {
        if (z.kolo) {
            const k = String(z.kolo).trim();
            if (!kolaZapasyMap[k]) kolaZapasyMap[k] = [];
            kolaZapasyMap[k].push({ ...z, id: mId, matchId: mId });
        }
    });

    const dohranaKolaSet = new Set();
    const otevrenaKolaSet = new Set();

    Object.keys(kolaZapasyMap).forEach(klicKola => {
        const zapasyVKole = kolaZapasyMap[klicKola];
        const vsetkoDohrano = zapasyVKole.length > 0 && zapasyVKole.every(z => z.vysledek_domaci !== undefined && z.vysledek_domaci !== null && z.apiStatus !== "IN_PLAY" && z.apiStatus !== "PAUSED");
        if (vsetkoDohrano) {
            dohranaKolaSet.add(klicKola);
        } else {
            const jeRozehrano = zapasyVKole.some(z => z.vysledek_domaci !== undefined || z.apiStatus === "IN_PLAY" || z.apiStatus === "PAUSED" || (z.datum && new Date(z.datum) <= new Date()));
            if (jeRozehrano) {
                otevrenaKolaSet.add(klicKola);
            }
        }
    });

    const perfektniKolaSeznam = [];

    if (pravidlaLigi.roundBonus && pravidlaLigi.roundBonus > 0) {
        dohranaKolaSet.forEach(klicKola => {
            const zapasyVKole = kolaZapasyMap[klicKola];
            Object.keys(RAM_USERS_PROFILES).forEach(uid => {
                if (!zebricekMapa[uid]) return;

                const uSouteze = RAM_USERS_TIPS[uid] || {};
                const uSoutezData = uSouteze[ligaKlic] || { tipy: {} };
                const uTips = uSoutezData.tipy || {};
                let maVsechnySpravne = true;

                for (const zap of zapasyVKole) {
                    const tip = uTips[zap.id || zap.matchId];
                    if (!tip) { maVsechnySpravne = false; break; }
                    const tipRozdil = parseInt(tip.tip_domaci) - parseInt(tip.tip_hoste);
                    const realRozdil = parseInt(zap.vysledek_domaci) - parseInt(zap.vysledek_hoste);
                    const spravna = (tipRozdil > 0 && realRozdil > 0) || (tipRozdil < 0 && realRozdil < 0) || (tipRozdil === 0 && realRozdil === 0);
                    if (!spravna) { maVsechnySpravne = false; break; }
                }

                if (maVsechnySpravne) {
                    zebricekMapa[uid].celkemBodu += pravidlaLigi.roundBonus;
                    zebricekMapa[uid].celkemBoduLive += pravidlaLigi.roundBonus;
                    if (zebricekMapa[uid].bodyPoKolech[klicKola] !== undefined) zebricekMapa[uid].bodyPoKolech[klicKola] += pravidlaLigi.roundBonus;
                    if (zebricekMapa[uid].bodyPoKolechLive[klicKola] !== undefined) zebricekMapa[uid].bodyPoKolechLive[klicKola] += pravidlaLigi.roundBonus;
                    
                    perfektniKolaSeznam.push({ uid: uid, nickname: zebricekMapa[uid].nickname, round: klicKola });
                }
            });
        });
    }

    Object.keys(zebricekMapa).forEach(uid => {
        let maxPts = 0;
        let maxKolo = '–';
        Object.entries(zebricekMapa[uid].bodyPoKolech).forEach(([klicKola, pts]) => {
            if (pts > maxPts) {
                maxPts = pts;
                maxKolo = klicKola;
            }
        });
        zebricekMapa[uid].nejviceBoduVKole = maxPts;
        zebricekMapa[uid].nejviceBoduVKoleNazev = maxKolo;

        let maxPtsLive = 0;
        let maxKoloLive = '–';
        Object.entries(zebricekMapa[uid].bodyPoKolechLive || {}).forEach(([klicKola, pts]) => {
            if (pts > maxPtsLive) {
                maxPtsLive = pts;
                maxKoloLive = klicKola;
            }
        });
        zebricekMapa[uid].nejviceBoduVKoleLive = maxPtsLive;
        zebricekMapa[uid].nejviceBoduVKoleNazevLive = maxKoloLive;
    });

    const vyhraVKolePocet = {};
    const vyhranaKolaSeznam = {};

    dohranaKolaSet.forEach(klicKola => {
        let maxPts = -Infinity;
        Object.keys(zebricekMapa).forEach(uid => {
            const pts = zebricekMapa[uid].bodyPoKolech?.[klicKola];
            if (pts !== undefined && pts > maxPts && pts > 0) maxPts = pts;
        });
        if (maxPts > 0) {
            Object.keys(zebricekMapa).forEach(uid => {
                if (zebricekMapa[uid].bodyPoKolech?.[klicKola] === maxPts) {
                    const nick = zebricekMapa[uid].nickname;
                    vyhraVKolePocet[nick] = (vyhraVKolePocet[nick] || 0) + 1;
                    if (!vyhranaKolaSeznam[nick]) vyhranaKolaSeznam[nick] = [];
                    vyhranaKolaSeznam[nick].push(klicKola);
                }
            });
        }
    });

    const vyhraVKolePocetLive = { ...vyhraVKolePocet };
    const vyhranaKolaSeznamLive = { ...vyhranaKolaSeznam };

    const vsechnyHraciKola = Object.keys(vyhraVKolePocet).map(nick => ({
        nickname: nick,
        count: vyhraVKolePocet[nick],
        rounds: (vyhranaKolaSeznam[nick] || []).join(', ')
    })).filter(p => p.count > 0);
    const unikatniHraciKolaBadges = [...new Set(vsechnyHraciKola.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
    const top3HraciKola = unikatniHraciKolaBadges.map(count => {
        const entries = vsechnyHraciKola.filter(p => p.count === count);
        const formattedArr = entries.map(e => `${e.nickname} (${e.rounds})`);
        return { count, names: formattedArr.join(', ') };
    });

    const top3HraciKolaLive = [...top3HraciKola];

    const vsechnyPresne = Object.keys(zebricekMapa).map(uid => ({
        nickname: zebricekMapa[uid].nickname,
        count: zebricekMapa[uid].presneVysledkyCount
    })).filter(p => p.count > 0);
    const unikatniPresneBadges = [...new Set(vsechnyPresne.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
    const top3Presne = unikatniPresneBadges.map(count => {
        const nicks = vsechnyPresne.filter(p => p.count === count).map(p => p.nickname);
        return { count, names: nicks.join(', ') };
    });

    const vsechnyPresneTop = Object.keys(zebricekMapa).map(uid => ({
        nickname: zebricekMapa[uid].nickname,
        count: zebricekMapa[uid].presneTopMatchesCount || 0
    })).filter(p => p.count > 0);
    const unikatniPresneTopBadges = [...new Set(vsechnyPresneTop.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
    const top3PresneTop = unikatniPresneTopBadges.map(count => {
        const nicks = vsechnyPresneTop.filter(p => p.count === count).map(p => p.nickname);
        return { count, names: nicks.join(', ') };
    });

    const vsechnyKolaZisky = [];
    Object.keys(zebricekMapa).forEach(uid => {
        const nickname = zebricekMapa[uid].nickname;
        Object.keys(zebricekMapa[uid].bodyPoKolech).forEach(klicKola => {
            const pts = zebricekMapa[uid].bodyPoKolech[klicKola];
            if (pts > 0) {
                vsechnyKolaZisky.push({ nickname, points: pts, round: klicKola });
            }
        });
    });

    const unikatniKolaZisky = [...new Set(vsechnyKolaZisky.map(p => p.points))].sort((a, b) => b - a).slice(0, 3);
    const top3Kola = unikatniKolaZisky.map(points => {
        const entries = vsechnyKolaZisky.filter(p => p.points === points);
        const formattedArr = entries.map(e => `${e.nickname} (${e.round})`);
        return { points, text: formattedArr.join(', ') };
    });

    const vsechnyPresneLive = Object.keys(zebricekMapa).map(uid => ({
        nickname: zebricekMapa[uid].nickname,
        count: zebricekMapa[uid].presneVysledkyCountLive
    })).filter(p => p.count > 0);
    const unikatniPresneBadgesLive = [...new Set(vsechnyPresneLive.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
    const top3PresneLive = unikatniPresneBadgesLive.map(count => {
        const nicks = vsechnyPresneLive.filter(p => p.count === count).map(p => p.nickname);
        return { count, names: nicks.join(', ') };
    });

    const vsechnyPresneTopLive = Object.keys(zebricekMapa).map(uid => ({
        nickname: zebricekMapa[uid].nickname,
        count: zebricekMapa[uid].presneTopMatchesCountLive || 0
    })).filter(p => p.count > 0);
    const unikatniPresneTopBadgesLive = [...new Set(vsechnyPresneTopLive.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
    const top3PresneTopLive = unikatniPresneTopBadgesLive.map(count => {
        const nicks = vsechnyPresneTopLive.filter(p => p.count === count).map(p => p.nickname);
        return { count, names: nicks.join(', ') };
    });

    const vsechnyTendence = Object.keys(zebricekMapa).map(uid => ({
        nickname: zebricekMapa[uid].nickname,
        count: zebricekMapa[uid].spravneTendenceCount || 0
    })).filter(p => p.count > 0);
    const unikatniTendenceBadges = [...new Set(vsechnyTendence.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
    const top3SpravneTendence = unikatniTendenceBadges.map(count => {
        const nicks = vsechnyTendence.filter(p => p.count === count).map(p => p.nickname);
        return { count, names: nicks.join(', ') };
    });

    const vsechnyTendenceLive = Object.keys(zebricekMapa).map(uid => ({
        nickname: zebricekMapa[uid].nickname,
        count: zebricekMapa[uid].spravneTendenceCountLive || 0
    })).filter(p => p.count > 0);
    const unikatniTendenceBadgesLive = [...new Set(vsechnyTendenceLive.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
    const top3SpravneTendenceLive = unikatniTendenceBadgesLive.map(count => {
        const nicks = vsechnyTendenceLive.filter(p => p.count === count).map(p => p.nickname);
        return { count, names: nicks.join(', ') };
    });

    const vsechnyKolaZiskyLive = [];
    Object.keys(zebricekMapa).forEach(uid => {
        const nickname = zebricekMapa[uid].nickname;
        Object.keys(zebricekMapa[uid].bodyPoKolechLive).forEach(klicKola => {
            const pts = zebricekMapa[uid].bodyPoKolechLive[klicKola];
            if (pts > 0) {
                vsechnyKolaZiskyLive.push({ nickname, points: pts, round: klicKola });
            }
        });
    });
    const unikatniKolaZiskyLive = [...new Set(vsechnyKolaZiskyLive.map(p => p.points))].sort((a, b) => b - a).slice(0, 3);
    const top3KolaLive = unikatniKolaZiskyLive.map(points => {
        const entries = vsechnyKolaZiskyLive.filter(p => p.points === points);
        const formattedArr = entries.map(e => `${e.nickname} (${e.round})`);
        return { points, text: formattedArr.join(', ') };
    });

    const otevrenaKolaArr = Array.from(otevrenaKolaSet).sort((a, b) => {
        const numA = parseInt(String(a).replace(/[^0-9]/g, '')) || 0;
        const numB = parseInt(String(b).replace(/[^0-9]/g, '')) || 0;
        return numA - numB;
    });

    const otevrenaKolaStatistiky = otevrenaKolaArr.map(klicKola => {
        const vsechnyZiskyVKole = Object.keys(zebricekMapa).map(uid => {
            const stats = zebricekMapa[uid];
            const pts = stats.bodyPoKolech[klicKola] || 0;
            return { nickname: stats.nickname, points: pts };
        }).filter(p => p.points > 0);

        const unikatniPts = [...new Set(vsechnyZiskyVKole.map(p => p.points))].sort((a, b) => b - a).slice(0, 3);
        const top3 = unikatniPts.map(points => {
            const nicks = vsechnyZiskyVKole.filter(p => p.points === points).map(p => p.nickname);
            return { points, names: nicks.join(', ') };
        });

        return {
            round: klicKola,
            top3: top3
        };
    });

    const otevrenaKolaStatistikyLive = otevrenaKolaArr.map(klicKola => {
        const vsechnyZiskyVKole = Object.keys(zebricekMapa).map(uid => {
            const stats = zebricekMapa[uid];
            const pts = stats.bodyPoKolechLive?.[klicKola] !== undefined ? stats.bodyPoKolechLive[klicKola] : (stats.bodyPoKolech[klicKola] || 0);
            return { nickname: stats.nickname, points: pts };
        }).filter(p => p.points > 0);

        const unikatniPts = [...new Set(vsechnyZiskyVKole.map(p => p.points))].sort((a, b) => b - a).slice(0, 3);
        const top3 = unikatniPts.map(points => {
            const nicks = vsechnyZiskyVKole.filter(p => p.points === points).map(p => p.nickname);
            return { points, names: nicks.join(', ') };
        });

        return {
            round: klicKola,
            top3: top3
        };
    });

    const zebricekPole = Object.keys(zebricekMapa).map(uid => {
        const pOtevrenaKola = otevrenaKolaArr.map(klicKola => ({
            round: klicKola,
            points: zebricekMapa[uid].bodyPoKolech[klicKola] || 0
        })).filter(k => k.points > 0 || otevrenaKolaArr.length === 1);

        return {
            uid: zebricekMapa[uid].uid, email: zebricekMapa[uid].email, nickname: zebricekMapa[uid].nickname,
            celkemBodu: zebricekMapa[uid].celkemBodu, natipovaneVyhodnocene: zebricekMapa[uid].natipovaneVyhodnocene,
            nenatipovaneVyhodnocene: zebricekMapa[uid].nenatipovaneVyhodnocene, presneVysledkyCount: zebricekMapa[uid].presneVysledkyCount,
            presneTopMatchesCount: zebricekMapa[uid].presneTopMatchesCount || 0,
            spravneTendenceCount: zebricekMapa[uid].spravneTendenceCount || 0,
            vyhranaKolaCount: vyhraVKolePocet[zebricekMapa[uid].nickname] || 0,
            perfektniKolaCount: (perfektniKolaSeznam.filter(pk => pk.uid === uid) || []).length,
            nejviceBoduVKole: zebricekMapa[uid].nejviceBoduVKole, nejviceBoduVKoleNazev: zebricekMapa[uid].nejviceBoduVKoleNazev || '–',
            vitezMs: zebricekMapa[uid].vitezMs, nejStrelec: zebricekMapa[uid].nejStrelec, nejKanadske: zebricekMapa[uid].nejKanadske,
            bodyKoloAktualni: zebricekMapa[uid].bodyPoKolech[aktivniKolo] || 0,
            otevrenaKola: pOtevrenaKola,
            efektivitaProcento: maxMoznychBoduZapasu > 0 ? (zebricekMapa[uid].bodyZapasuCelkem / maxMoznychBoduZapasu) * 100 : 0
        };
    }).sort((a, b) => {
        if (b.celkemBodu !== a.celkemBodu) return b.celkemBodu - a.celkemBodu;
        return b.presneVysledkyCount - a.presneVysledkyCount;
    });

    const zebricekLivePole = Object.keys(zebricekMapa).map(uid => {
        const pOtevrenaKolaLive = otevrenaKolaArr.map(klicKola => ({
            round: klicKola,
            points: zebricekMapa[uid].bodyPoKolechLive?.[klicKola] !== undefined ? zebricekMapa[uid].bodyPoKolechLive[klicKola] : (zebricekMapa[uid].bodyPoKolech[klicKola] || 0)
        })).filter(k => k.points > 0 || otevrenaKolaArr.length === 1);

        return {
            uid: zebricekMapa[uid].uid, email: zebricekMapa[uid].email, nickname: zebricekMapa[uid].nickname,
            celkemBodu: zebricekMapa[uid].celkemBoduLive, natipovaneVyhodnocene: zebricekMapa[uid].natipovaneVyhodnoceneLive,
            nenatipovaneVyhodnocene: zebricekMapa[uid].nenatipovaneVyhodnoceneLive, presneVysledkyCount: zebricekMapa[uid].presneVysledkyCountLive,
            presneTopMatchesCount: zebricekMapa[uid].presneTopMatchesCountLive || 0,
            spravneTendenceCount: zebricekMapa[uid].spravneTendenceCountLive || 0,
            vyhranaKolaCount: vyhraVKolePocetLive[zebricekMapa[uid].nickname] || 0,
            perfektniKolaCount: (perfektniKolaSeznam.filter(pk => pk.uid === uid) || []).length,
            nejviceBoduVKole: zebricekMapa[uid].nejviceBoduVKoleLive || zebricekMapa[uid].nejviceBoduVKole || 0, nejviceBoduVKoleNazev: zebricekMapa[uid].nejviceBoduVKoleNazevLive || zebricekMapa[uid].nejviceBoduVKoleNazev || '–',
            vitezMs: zebricekMapa[uid].vitezMs, nejStrelec: zebricekMapa[uid].nejStrelec, nejKanadske: zebricekMapa[uid].nejKanadske,
            bodyKoloAktualni: zebricekMapa[uid].bodyPoKolechLive?.[aktivniKolo] !== undefined ? zebricekMapa[uid].bodyPoKolechLive[aktivniKolo] : (zebricekMapa[uid].bodyPoKolech[aktivniKolo] || 0),
            otevrenaKola: pOtevrenaKolaLive,
            efektivitaProcento: maxMoznychBoduZapasu > 0 ? (zebricekMapa[uid].bodyZapasuCelkemLive / maxMoznychBoduZapasu) * 100 : 0
        };
    }).sort((a, b) => {
        if (b.celkemBodu !== a.celkemBodu) return b.celkemBodu - a.celkemBodu;
        return b.presneVysledkyCount - a.presneVysledkyCount;
    });

    zebricekLivePole.forEach(p => {
        const uid = p.uid;
        if (zebricekMapa[uid] && zebricekMapa[uid].bodyPoKolechLive) {
            p.bodyKoloAktualni = zebricekMapa[uid].bodyPoKolechLive[aktivniKolo] !== undefined ? zebricekMapa[uid].bodyPoKolechLive[aktivniKolo] : (zebricekMapa[uid].bodyPoKolech[aktivniKolo] || 0);
        }
    });

    zebricekLivePole.forEach((pLive, idxLive) => {
        const idxOfficial = zebricekPole.findIndex(pOff => pOff.uid === pLive.uid);
        pLive.poziceDelta = idxOfficial !== -1 ? (idxOfficial - idxLive) : 0;
    });

    const liveMatchIds = Object.keys(centralMatches).filter(id => {
        const z = centralMatches[id];
        return z.apiStatus === "IN_PLAY" || z.apiStatus === "PAUSED";
    });

    const timestampNow = new Date().toISOString();
    const radarStats = spoctiRadarStatistikyBot(centralMatches, RAM_USERS_PROFILES, RAM_USERS_TIPS, leagueName);

    // 👑 BLESKOVÝ SOUHRN KOL PRO BANNER (HRÁČ KOLA, TOP ZÁPAS & NEJVÍC PŘESNÝCH)
    const kolaSouhrn = {};
    Object.keys(kolaZapasyMap).forEach(klicKola => {
        const zapasyVKole = kolaZapasyMap[klicKola] || [];
        const isLiveOrStartedRound = zapasyVKole.some(z => z.vysledek_domaci !== undefined || z.apiStatus === "IN_PLAY" || z.apiStatus === "PAUSED" || (z.datum && new Date(z.datum) <= new Date()));

        let maxPtsRound = -Infinity;
        Object.keys(zebricekMapa).forEach(uid => {
            const pts = zebricekMapa[uid].bodyPoKolechLive?.[klicKola] !== undefined
                ? zebricekMapa[uid].bodyPoKolechLive[klicKola]
                : (zebricekMapa[uid].bodyPoKolech?.[klicKola] || 0);
            if (pts > maxPtsRound) maxPtsRound = pts;
        });

        let hraciKolaObj = null;
        if (isLiveOrStartedRound && maxPtsRound > 0) {
            const winners = [];
            Object.keys(zebricekMapa).forEach(uid => {
                const pts = zebricekMapa[uid].bodyPoKolechLive?.[klicKola] !== undefined
                    ? zebricekMapa[uid].bodyPoKolechLive[klicKola]
                    : (zebricekMapa[uid].bodyPoKolech?.[klicKola] || 0);
                if (pts === maxPtsRound) {
                    winners.push(zebricekMapa[uid].nickname);
                }
            });
            hraciKolaObj = {
                names: winners.join(', '),
                points: maxPtsRound,
                count: winners.length
            };
        }

        // 🎯 VÝPOČET NEJVĚTŠÍHO POČTU PŘESNÝCH VÝSLEDKŮ V KOLE (PRO LIGU MISTRŮ)
        let nejvicPresnychObj = null;
        if (isLiveOrStartedRound) {
            const exactCounts = {};
            let maxExactRound = 0;

            Object.keys(RAM_USERS_PROFILES).forEach(uid => {
                const p = RAM_USERS_PROFILES[uid];
                if (!p.leagues || !p.leagues.includes(leagueName)) return;

                const uSouteze = RAM_USERS_TIPS[uid] || {};
                const uTips = (uSouteze[ligaKlic] && uSouteze[ligaKlic].tipy) ? uSouteze[ligaKlic].tipy : {};
                let userExact = 0;

                zapasyVKole.forEach(zap => {
                    const vDom = zap.vysledek_domaci;
                    const vHos = zap.vysledek_hoste;
                    if (vDom !== undefined && vDom !== null && vHos !== undefined && vHos !== null) {
                        const uTip = uTips[zap.id];
                        if (uTip && uTip.tip_domaci !== undefined && uTip.tip_domaci !== null && String(uTip.tip_domaci).trim() !== '') {
                            const tD = parseInt(uTip.tip_domaci);
                            const tH = parseInt(uTip.tip_hoste);
                            const rD = parseInt(vDom);
                            const rH = parseInt(vHos);
                            const isExact = (tD === rD && tH === rH && (!zap.isPlayoff || rD !== rH || uTip.postup === zap.postup));
                            if (isExact) userExact++;
                        }
                    }
                });

                exactCounts[uid] = userExact;
                if (userExact > maxExactRound) maxExactRound = userExact;
            });

            if (maxExactRound > 0) {
                const exactWinners = [];
                Object.keys(exactCounts).forEach(uid => {
                    if (exactCounts[uid] === maxExactRound) {
                        exactWinners.push(RAM_USERS_PROFILES[uid]?.nickname || zebricekMapa[uid]?.nickname || 'Hráč');
                    }
                });
                nejvicPresnychObj = {
                    names: exactWinners.join(', '),
                    count: maxExactRound
                };
            }
        }

        let topMatchObj = null;
        if (pravidlaLigi.hasTopMatch) {
            const topMatch = zapasyVKole.find(z => z.isTopMatch);
            if (topMatch) {
                const isTopStarted = (topMatch.vysledek_domaci !== undefined && topMatch.vysledek_domaci !== null) ||
                                     topMatch.apiStatus === "IN_PLAY" || topMatch.apiStatus === "PAUSED" ||
                                     (topMatch.datum && new Date(topMatch.datum) <= new Date());
                
                const exactUsers = [];
                if (isTopStarted && topMatch.vysledek_domaci !== undefined && topMatch.vysledek_domaci !== null) {
                    const rD = parseInt(topMatch.vysledek_domaci);
                    const rH = parseInt(topMatch.vysledek_hoste);

                    Object.keys(RAM_USERS_PROFILES).forEach(uid => {
                        const p = RAM_USERS_PROFILES[uid];
                        if (!p.leagues || !p.leagues.includes(leagueName)) return;

                        const uSouteze = RAM_USERS_TIPS[uid] || {};
                        const uTips = (uSouteze[ligaKlic] && uSouteze[ligaKlic].tipy) ? uSouteze[ligaKlic].tipy : {};
                        const uTip = uTips[topMatch.id];

                        if (uTip && uTip.tip_domaci !== undefined && uTip.tip_domaci !== null && String(uTip.tip_domaci).trim() !== '') {
                            const tD = parseInt(uTip.tip_domaci);
                            const tH = parseInt(uTip.tip_hoste);
                            const isExact = (tD === rD && tH === rH && (!topMatch.isPlayoff || rD !== rH || uTip.postup === topMatch.postup));
                            if (isExact) {
                                exactUsers.push(p.nickname);
                            }
                        }
                    });
                }

                topMatchObj = {
                    hasTopMatch: true,
                    isStarted: isTopStarted,
                    isEvaluated: topMatch.vysledek_domaci !== undefined && topMatch.vysledek_domaci !== null,
                    domaci: topMatch.domaci,
                    hoste: topMatch.hoste,
                    exactCount: exactUsers.length,
                    exactUsers: exactUsers
                };
            }
        }

        kolaSouhrn[klicKola] = {
            hracKola: hraciKolaObj,
            topMatch: topMatchObj,
            nejvicPresnych: nejvicPresnychObj
        };
    });

    const leaderboardJson = {
        zebricek: zebricekPole, 
        zebricekLive: zebricekLivePole, 
        isLive: liveMatchIds.length > 0, 
        mapaPrezdivek: mapaPrezdivek,
        top3Presne: top3Presne,
        top3PresneTop: top3PresneTop,
        top3SpravneTendence: top3SpravneTendence,
        top3SpravneTendenceLive: top3SpravneTendenceLive,
        top3HraciKola: top3HraciKola,
        top3HraciKolaLive: top3HraciKolaLive,
        perfektniKola: perfektniKolaSeznam,
        top3Kola: top3Kola,
        top3PresneLive: top3PresneLive,
        top3PresneTopLive: top3PresneTopLive,
        top3KolaLive: top3KolaLive,
        otevrenaKolaStatistiky: otevrenaKolaStatistiky,
        otevrenaKolaStatistikyLive: otevrenaKolaStatistikyLive,
        otevrenaKolaSeznam: otevrenaKolaArr,
        aktivniKoloText: aktivniKolo,
        kolaSouhrn: kolaSouhrn,
        radar: radarStats,
        aktualizovano: timestampNow
    };

    const pocetZapasu = Object.keys(centralMatches).length;
    const hasMatches = pocetZapasu > 0;

    // 🧠 OBOHACENÍ ROZPISU: Přibalení sezónní formy (V/R/P) a kurzů Bet365 k zápasům
    const zapasyMapaObohacena = {};
    Object.entries(centralMatches).forEach(([mId, z]) => {
        const dTrans = z.domaci;
        const hTrans = z.hoste;
        const matchKey = `${PL_NORM(dTrans)} vs ${PL_NORM(hTrans)}`;
         const matchOdds = RAM_CENTRAL_ODDS[leagueName]?.[matchKey] || RAM_CENTRAL_ODDS[leagueName]?.[mId] || z.odds || null;
        const formaDomaci = spoctiSezonniFormuTymu(dTrans, z.datum, centralMatches);
        const formaHoste = spoctiSezonniFormuTymu(hTrans, z.datum, centralMatches);

        // 🎯 KONTROLA: Byl den tohoto zápasu reálně poslán ke stažení do RapidAPI?
        const isHockey = leagueName.includes("hokej") || leagueName.includes("Extraliga");
        const sportKlic = isHockey ? "ice-hockey" : "football";
        const datumIso = z.datum ? new Date(z.datum).toISOString().split("T")[0] : null;
        const dayKey = datumIso ? `${sportKlic}_${datumIso}` : null;
        const bylDenZpracovan = Boolean(dayKey && RAM_PROCESSED_ODDS_DAYS.has(dayKey));

        zapasyMapaObohacena[mId] = {
            ...z,
            odds: matchOdds,
            oddsChecked: bylDenZpracovan,
            forma: {
                domaci: formaDomaci,
                hoste: formaHoste
            }
        };
    });

    const rozpisJson = { 
        zapasyMapa: zapasyMapaObohacena, 
        hasMatches: hasMatches, 
        aktualizovano: timestampNow 
    };

    // 🛡️ KONTROLA OTISKU: Čistý a stabilní otisk z reálných herních dat (včetně kurzů 1-X-2)
    const cistaDataZapasu = Object.entries(centralMatches).map(([id, z]) => 
        `${id}:${z.datum}_${z.vysledek_domaci}_${z.vysledek_hoste}_${z.apiStatus}_${z.isTopMatch}_${z.postup}`
    ).sort().join('|');

    const cisteBodyTabulky = zebricekPole.map(p => 
        `${p.uid}:${p.celkemBodu}_${p.presneVysledkyCount}_${p.spravneTendenceCount}_${p.celkemBoduLive}`
    ).sort().join('|');

    const cistaKurzyOtisk = Object.entries(RAM_CENTRAL_ODDS[leagueName] || {}).map(([k, o]) => 
        `${k}:${o["1"]}_${o["X"]}_${o["2"]}`
    ).sort().join('|');

    const aktualniOtisk = `${cistaDataZapasu}#${cisteBodyTabulky}#${cistaKurzyOtisk}#${liveMatchIds.length > 0}`;

    const dataSeZmenila = (RAM_LAST_DATA_SIGNATURES[leagueName] !== aktualniOtisk);

    if (dataSeZmenila || forceWriteHistory) {
        RAM_LAST_DATA_SIGNATURES[leagueName] = aktualniOtisk;
        await uploadToR2(leagueName, "leaderboard.json", leaderboardJson);
        await uploadToR2(leagueName, "rozpis.json", rozpisJson);
        await rekonstruujPoharProLigu(leagueName, zebricekPole, centralMatches);

        // 🛡️ Zápis pulsu se provede VÝHRADNĚ tehdy, pokud se reálně změnila data (ne kvůli historii!)
        if (dataSeZmenila) {
            try {
                const pulsRef = db.collection('ligy').doc(leagueName).collection('stav').doc('puls');
                await pulsRef.set({
                    verzeRozpisu: admin.firestore.FieldValue.increment(1),
                    verzeZebricku: admin.firestore.FieldValue.increment(1),
                    aktualizovano: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
                console.log(`📡 PULS SYNC [${leagueName}]: Změna dat detekována -> Firestore puls aktualizován.`);
            } catch (pulsErr) {
                console.error(`❌ Selhal zápis pulsu pro ${leagueName}:`, pulsErr);
            }
        } else {
            console.log(`🛡️ HISTORIE SYNC [${leagueName}]: Zpracována událost bez změny dat (0 Firestore puls).`);
        }
    }

    if (forceWriteHistory) {
        const uploadTasks = [];

        for (const uid of Object.keys(RAM_USERS_PROFILES)) {
            const uSouteze = RAM_USERS_TIPS[uid] || {};
            const hracovyTipyVsechny = (uSouteze[ligaKlic] && uSouteze[ligaKlic].tipy) ? uSouteze[ligaKlic].tipy : {};
            const hracovyTipyOdemcene = {};

            Object.keys(hracovyTipyVsechny).forEach(mId => {
                const zapas = centralMatches[mId];
                const jeOdemceny = zapas && (new Date(zapas.datum) <= new Date() || zapas.vysledek_domaci !== undefined || zapas.apiStatus === "IN_PLAY" || zapas.apiStatus === "FINISHED");
                if (jeOdemceny) {
                    hracovyTipyOdemcene[mId] = hracovyTipyVsechny[mId];
                }
            });

            const historieJson = { mapaTipu: hracovyTipyOdemcene, vytvoreno: timestampNow };
            uploadTasks.push(() => uploadToR2(leagueName, `historie_hrace_${uid}.json`, historieJson));
        }

        Object.keys(centralMatches).forEach(mId => {
            const zapas = centralMatches[mId];
            const jeOdemceny = zapas && (new Date(zapas.datum) <= new Date() || zapas.vysledek_domaci !== undefined || zapas.apiStatus === "IN_PLAY" || zapas.apiStatus === "FINISHED");
            const jeLive = zapas && (zapas.apiStatus === "IN_PLAY" || zapas.apiStatus === "PAUSED");
            const potrebujeUpload = jeOdemceny && (jeLive || !zapas.spyR2Synced);

            if (potrebujeUpload) {
                const tipyProZapasPole = [];
                Object.keys(RAM_USERS_PROFILES).forEach(uid => {
                    const p = RAM_USERS_PROFILES[uid];
                    if (!p.leagues || !p.leagues.includes(leagueName)) return;

                    const uSouteze = RAM_USERS_TIPS[uid] || {};
                    const uTips = (uSouteze[ligaKlic] && uSouteze[ligaKlic].tipy) ? uSouteze[ligaKlic].tipy : {};
                    const uTip = uTips[mId];

                    if (uTip && uTip.tip_domaci !== undefined && uTip.tip_domaci !== null && String(uTip.tip_domaci).trim() !== '') {
                        tipyProZapasPole.push({
                            uid: uid,
                            userEmail: p.email,
                            nickname: p.nickname,
                            tip_domaci: parseInt(uTip.tip_domaci),
                            tip_hoste: parseInt(uTip.tip_hoste),
                            postup: uTip.postup || ''
                        });
                    }
                });

                const spyJson = { tipy: tipyProZapasPole, aktualizovano: timestampNow };
                uploadTasks.push(async () => {
                    await uploadToR2(leagueName, `spy_zapas_${mId}.json`, spyJson);
                    if (!jeLive && zapas.apiStatus === "FINISHED") {
                        zapas.spyR2Synced = true;
                    }
                });
            }
        });

        // 🚀 DÁVKOVÝ ZÁPIS PO 5 BEZ SÍŤOVÉHO ZAHLACENÍ A BEZ SETTIMEOUT
        const CHUNK_SIZE = 5;
        for (let i = 0; i < uploadTasks.length; i += CHUNK_SIZE) {
            await Promise.all(uploadTasks.slice(i, i + CHUNK_SIZE).map(fn => fn()));
        }
    }

    try {
        const nyniMs = Date.now();
        let ligaBeziLive = false;
        let minBudouciMs = Infinity;
        let pristiZapasIso = null;

        Object.values(centralMatches).forEach(z => {
            const isFinished = z.apiStatus === "FINISHED" || (z.vysledek_domaci !== undefined && z.vysledek_domaci !== null && z.apiStatus !== "IN_PLAY" && z.apiStatus !== "PAUSED");
            const isPostponed = z.apiStatus === "POSTPONED";
            const startMs = Date.parse(z.datum);

            if (!isFinished && !isPostponed) {
                if (z.apiStatus === "IN_PLAY" || z.apiStatus === "PAUSED") {
                    ligaBeziLive = true;
                } else if (!isNaN(startMs) && startMs > nyniMs && startMs < minBudouciMs) {
                    minBudouciMs = startMs;
                    pristiZapasIso = z.datum;
                }
            }
        });

        await db.collection("ligy").doc(leagueName).collection("stav").doc("radar").set({
            beziLive: ligaBeziLive,
            pristiZapasUtc: pristiZapasIso || null,
            aktualizovano: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (radarErr) {
        console.error(`❌ Selhal autonomní zápis radaru pro ${leagueName}:`, radarErr);
    }
}

let isHeartbeatRunning = false;

async function fetchV2WithFastRetry(url, headers, maxPokusu = 2, timeoutMs = 9000) {
    for (let pokus = 1; pokus <= maxPokusu; pokus++) {
        try {
            const res = await fetch(url, {
                headers: headers,
                signal: AbortSignal.timeout(timeoutMs)
            });
            if (res.ok) {
                return await res.json();
            }
            console.log(`⚠️ Live API vrácen kód ${res.status} (pokus ${pokus}/${maxPokusu})...`);
        } catch (err) {
            console.log(`⚠️ Live API pokus ${pokus}/${maxPokusu} selhal nebo vypršel timeout (${err.message})...`);
        }
    }
    return null;
}

// =========================================================================
// 🚀 LIVE ENGINE: V2 LIVESCORE API
// =========================================================================
async function providniApiHeartbeat() {
    if (isHeartbeatRunning) return;
    isHeartbeatRunning = true;

    try {
        if (!RAM_BOT_CONFIG.active) return;

        const dbKey = process.env.THESPORTSDB_KEY;
        if (!dbKey) return;

        const nyni = new Date();
        const nyniMs = nyni.getTime();

        let celkovyObsahujeAktivniZapas = false;
        const zmeneneLigySet = new Set();

        const v2Headers = {
            "X-API-KEY": dbKey,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Accept": "application/json"
        };

        let maAktivniFotbal = false;
        let maAktivniHokej = false;

        for (const leagueName of SEZNAM_LIG) {
            const centralZapasy = RAM_CENTRAL_MATCHES[leagueName] || {};
            const zapasyPole = Object.values(centralZapasy);

            for (const [mId, stary] of Object.entries(centralZapasy)) {
                if (stary.apiStatus === "FINISHED" || stary.spyUploaded) continue;

                const startMs = Date.parse(stary.datum);
                const isPastKickoff = !isNaN(startMs) && (nyniMs >= startMs);
                if (isPastKickoff) {
                    console.log(`🔒 LOCK T-0 [${leagueName}]: Výkop zápasu ${stary.domaci} – ${stary.hoste}. Zmrazuji tipy!`);
                    stary.spyUploaded = true;
                    zmeneneLigySet.add(leagueName);
                }
            }

            const maLiveZapas = zapasyPole.some(z => {
                const isFinished = z.apiStatus === "FINISHED" || (z.vysledek_domaci !== undefined && z.vysledek_domaci !== null && z.apiStatus !== "IN_PLAY" && z.apiStatus !== "PAUSED");
                if (isFinished) return false;
                const startMs = Date.parse(z.datum);
                if (isNaN(startMs)) return false;
                const rozdilMinut = (startMs - nyniMs) / (1000 * 60);
                return z.apiStatus === "IN_PLAY" || z.apiStatus === "PAUSED" || (rozdilMinut <= 15 && rozdilMinut >= -240);
            });

            if (maLiveZapas) {
                celkovyObsahujeAktivniZapas = true;
                if (leagueName.includes("hokej") || leagueName.includes("Extraliga")) {
                    maAktivniHokej = true;
                } else {
                    maAktivniFotbal = true;
                }
            }
        }

        const liveEventsMapa = {};

        if (maAktivniFotbal) {
            try {
                const json = await fetchV2WithFastRetry("https://www.thesportsdb.com/api/v2/json/livescore/soccer", v2Headers, 2, 9000);
                if (json) {
                    const items = json.livescore || json.events || [];
                    items.forEach(ev => { if (ev.idEvent) liveEventsMapa[String(ev.idEvent)] = ev; });
                }
            } catch (e) {
                console.error("❌ Chyba V2 soccer livescore:", e.message);
            }
        }

        if (maAktivniHokej) {
            try {
                const json = await fetchV2WithFastRetry("https://www.thesportsdb.com/api/v2/json/livescore/ice-hockey", v2Headers, 2, 9000);
                if (json) {
                    const items = json.livescore || json.events || [];
                    items.forEach(ev => { if (ev.idEvent) liveEventsMapa[String(ev.idEvent)] = ev; });
                }
            } catch (e) {
                console.error("❌ Chyba V2 hockey livescore:", e.message);
            }
        }

        for (const leagueName of SEZNAM_LIG) {
            const centralZapasy = RAM_CENTRAL_MATCHES[leagueName] || {};

            for (const [apiId, stary] of Object.entries(centralZapasy)) {
                const liveItem = liveEventsMapa[apiId];
                const startZapasuMs = Date.parse(stary.datum);
                const isPastKickoff = !isNaN(startZapasuMs) && (nyniMs >= startZapasuMs);
                const isFinishedStary = stary.apiStatus === "FINISHED";

                if (isFinishedStary) continue;

                if (liveItem) {
                    const statusRaw = String(liveItem.strStatus || "").trim().toUpperCase();
                    const isFinished = ["MATCH FINISHED", "FT", "AOT", "AP", "FINISHED", "FULL TIME", "ENDED"].includes(statusRaw);
                    const hasScore = liveItem.intHomeScore !== null && liveItem.intHomeScore !== undefined && String(liveItem.intHomeScore).trim() !== "" &&
                                     liveItem.intAwayScore !== null && liveItem.intAwayScore !== undefined && String(liveItem.intAwayScore).trim() !== "";

                    let golyDomaci = hasScore ? parseInt(liveItem.intHomeScore, 10) : (stary.vysledek_domaci !== undefined ? stary.vysledek_domaci : 0);
                    let golyHoste = hasScore ? parseInt(liveItem.intAwayScore, 10) : (stary.vysledek_hoste !== undefined ? stary.vysledek_hoste : 0);
                    let novyStatus = isFinished ? "FINISHED" : "IN_PLAY";

                    const skoreSeZmenilo = (stary.vysledek_domaci !== golyDomaci) || (stary.vysledek_hoste !== golyHoste);
                    const statusSeZmenil = (stary.apiStatus !== novyStatus);

                    if (skoreSeZmenilo || statusSeZmenil) {
                        console.log(`⚽ V2 LIVE [${leagueName}]: ${stary.domaci} ${golyDomaci} : ${golyHoste} ${stary.hoste} (${novyStatus})`);
                        stary.apiStatus = novyStatus;
                        stary.vysledek_domaci = golyDomaci;
                        stary.vysledek_hoste = golyHoste;
                        zmeneneLigySet.add(leagueName);

                        db.collection("ligy").doc(leagueName)
                          .collection("sezony").doc(SEZONA_ID)
                          .collection("zapasy").doc(apiId)
                          .set({ apiStatus: novyStatus, vysledek_domaci: golyDomaci, vysledek_hoste: golyHoste }, { merge: true })
                          .catch(e => console.error(`❌ Firestore Sync Error:`, e.message));
                    }
                }
            }
        }

        for (const lName of zmeneneLigySet) {
            await rekonstruujAgregatyProLigu(lName, true);
        }

        if (celkovyObsahujeAktivniZapas) {
            console.log(`[${nyni.toLocaleTimeString('cs-CZ')}] 🚀 STATUS: Zápasy aktivně běží.`);
        }
        await aktualizujLiveRadarR2();
    } catch (err) {
        console.error(`❌ Kritická chyba v Heartbeat:`, err);
    } finally {
        isHeartbeatRunning = false;
    }
}

function parsujZapasDatumDoIso(item) {
    let rawStr = item.strTimestamp || (item.dateEvent ? `${item.dateEvent}T${item.strTime || "00:00:00"}` : null);
    if (!rawStr) return new Date().toISOString();

    rawStr = String(rawStr).replace(" ", "T");
    if (!rawStr.endsWith("Z") && !rawStr.includes("+")) {
        rawStr += "Z";
    }
    const d = new Date(rawStr);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// 📅 HLOUBKOVÝ KALENDÁŘ: Synchronizuje kompletní rozpis
async function synchronizujRozpisyVsechLig() {
    console.log("=========================================================================");
    console.log("📅 SERVISNÍ KALENDÁŘ: Spouštím hloubkovou synchronizaci zápasů všech lig...");
    console.log("=========================================================================");

    const dbKey = process.env.THESPORTSDB_KEY;
    if (!dbKey) return;

    RAM_IS_SYNCING = true;

    try {
        for (const leagueName of SEZNAM_LIG) {
            const leagueConfig = LIGY_API_MAPA[leagueName] || { id: "WC", provider: "MANUAL" };
            if (leagueConfig.provider === "MANUAL") continue;

            try {
                const sezoneYear = String(SEZONA_ID).replace("_", "-");
                const targetApiUrl = `https://www.thesportsdb.com/api/v1/json/${dbKey}/eventsseason.php?id=${leagueConfig.id}&s=${sezoneYear}`;
                const fetchHeaders = {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
                    "Accept": "application/json, text/plain, */*"
                };

                let response = null;
                for (let pokus = 1; pokus <= 2; pokus++) {
                    try {
                        response = await fetch(targetApiUrl, { 
                            headers: fetchHeaders,
                            signal: AbortSignal.timeout(9000)
                        });
                        if (response.ok) break;
                        console.log(`⚠️ KALENDÁŘ [${leagueName}]: API vrátilo ${response.status} (pokus ${pokus}/2)...`);
                    } catch (fetchErr) {
                        console.log(`⚠️ KALENDÁŘ [${leagueName}]: Pokus ${pokus}/2 selhal (${fetchErr.message})...`);
                    }
                }

                if (!response || !response.ok) {
                    console.error(`❌ KALENDÁŘ [${leagueName}]: Nepodařilo se stáhnout rozpis.`);
                    continue;
                }

                const apiData = await response.json();
                const rawItems = apiData.events || [];
                console.log(`🔎 KALENDÁŘ [${leagueName}]: Načteno ${rawItems.length} zápasů.`);

                let itemsToProcess = rawItems;

                // 🧠 ČASOVÝ SHLUKOVAČ PRO LIGU MISTRŮ (8 kol po 18 zápasech + jarní Play-off)
                if (leagueName === "Liga mistrů") {
                    const filtered = rawItems.filter(item => {
                        const stageStr = String(item.strStage || "").toUpperCase();
                        const isQualifying = stageStr.includes("QUALIFY") || stageStr.includes("PRELIMINARY");
                        const iso = parsujZapasDatumDoIso(item);
                        const datumMs = Date.parse(iso);
                        if (isQualifying) return false;
                        // 🛡️ Filtrujeme POUZE letní předkola z roku 2026 (před 1. 9. 2026), Leden 2027 (7. a 8. kolo) necháváme projít!
                        if (datumMs) {
                            const d = new Date(datumMs);
                            const isSummer2026 = (d.getFullYear() === 2026 && d.getMonth() < 8);
                            if (isSummer2026 && !stageStr.includes("LEAGUE")) return false;
                        }
                        return true;
                    });

                    filtered.sort((a, b) => {
                        const tA = Date.parse(parsujZapasDatumDoIso(a)) || 0;
                        const tB = Date.parse(parsujZapasDatumDoIso(b)) || 0;
                        return tA - tB;
                    });

                    let currentRound = 1;
                    let lastClusterStartMs = 0;

                    filtered.forEach(item => {
                        const iso = parsujZapasDatumDoIso(item);
                        const matchMs = Date.parse(iso) || 0;
                        const stageStr = String(item.strStage || "").toUpperCase();
                        const d = new Date(matchMs);
                        const isSpringPlayoff = (d.getFullYear() === 2027 && d.getMonth() >= 1) || stageStr.includes("PLAYOFF") || stageStr.includes("KNOCKOUT") || stageStr.includes("ROUND_OF_16") || stageStr.includes("QUARTER") || stageStr.includes("SEMI") || stageStr.includes("FINAL");

                        if (isSpringPlayoff) {
                            item._customKolo = "Play-off";
                            item._customIsPlayoff = false; // 👈 Pro LM tipujeme pouze 90 minut, vyřazovací příznak se nezapíná
                        } else {
                            if (lastClusterStartMs === 0) {
                                lastClusterStartMs = matchMs;
                            } else if (matchMs - lastClusterStartMs > 4 * 24 * 60 * 60 * 1000) {
                                currentRound++;
                                lastClusterStartMs = matchMs;
                            }
                            item._customKolo = `${currentRound}. kolo`;
                            item._customIsPlayoff = false;
                        }
                    });

                    itemsToProcess = filtered;
                }

                // ⚡ PŘÍRŮSTKOVÝ DELTA ZÁPIS DO FIRESTORE (Zapíše POUZE skutečně změněné zápasy)
                let batch = db.batch();
                let batchOpCount = 0;
                let ligaZmenena = false;

                for (const item of itemsToProcess) {
                    const apiId = String(item.idEvent);
                    const rawDomaci = (item.strHomeTeam || "Neznámý").replace(/ Prague/g, " Praha");
                    const rawHoste = (item.strAwayTeam || "Neznámý").replace(/ Prague/g, " Praha");
                    const domaci = slovnikTymu[rawDomaci] || rawDomaci;
                    const hoste = slovnikTymu[rawHoste] || rawHoste;
                    const roundNum = parseInt(item.intRound) || 1;
                    const isPlayoff = item._customIsPlayoff !== undefined 
                        ? item._customIsPlayoff 
                        : (item.strStage && item.strStage !== "GROUP_STAGE" && item.strStage !== "REGULAR_SEASON");

                    const matchIsoDate = parsujZapasDatumDoIso(item);
                    let spravneKolo = item._customKolo || `${roundNum}. kolo`;
                    const stary = RAM_CENTRAL_MATCHES[leagueName]?.[apiId] || {};

                    const statusRaw = String(item.strStatus || "").trim().toUpperCase();
                    const isPostponed = ["POSTPONED", "PST", "CANCELLED", "SUSPENDED", "ABANDONED"].includes(statusRaw) || String(item.strPostponed || "").toLowerCase() === "yes";
                    const isFinishedApi = ["MATCH FINISHED", "FT", "AOT", "AP", "FINISHED", "FULL TIME", "ENDED"].includes(statusRaw);
                    const hasScoreApi = item.intHomeScore !== null && item.intHomeScore !== undefined && String(item.intHomeScore).trim() !== "" &&
                                        item.intAwayScore !== null && item.intAwayScore !== undefined && String(item.intAwayScore).trim() !== "";

                    const matchPayload = {
                        domaci: domaci,
                        hoste: hoste,
                        datum: matchIsoDate,
                        kolo: spravneKolo,
                        isPlayoff: isPlayoff || false
                    };

                    // 🛡️ OCHRANA: Pokud zápas v DB ještě NENÍ uzavřený, ale API už má finální skóre (FT), bezpečně dotáhneme výsledek
                    const uzJeUzavrenyVDB = (stary.apiStatus === "FINISHED") || (stary.vysledek_domaci !== undefined && stary.vysledek_domaci !== null && stary.apiStatus !== "IN_PLAY" && stary.apiStatus !== "PAUSED");

                    if (!uzJeUzavrenyVDB && isFinishedApi && hasScoreApi) {
                        const gDom = parseInt(item.intHomeScore, 10);
                        const gHos = parseInt(item.intAwayScore, 10);
                        matchPayload.apiStatus = "FINISHED";
                        matchPayload.vysledek_domaci = gDom;
                        matchPayload.vysledek_hoste = gHos;
                        console.log(`🛡️ KALENDÁŘ FALLBACK [${leagueName}]: Záchrana výsledku pro ${domaci} ${gDom}:${gHos} ${hoste} (FINISHED)`);
                    } else if (isPostponed) {
                        matchPayload.apiStatus = "POSTPONED";
                    } else if (stary.apiStatus === "POSTPONED" && !isPostponed) {
                        matchPayload.apiStatus = "SCHEDULED";
                    }

                    if (stary.isTopMatch) matchPayload.isTopMatch = true;

                    // 🔍 DELTA CHECK: Porovnáme matchPayload s existujícím stavem v RAM
                    const jeBezezmeny = (
                        stary.domaci === matchPayload.domaci &&
                        stary.hoste === matchPayload.hoste &&
                        stary.datum === matchPayload.datum &&
                        stary.kolo === matchPayload.kolo &&
                        stary.isPlayoff === matchPayload.isPlayoff &&
                        stary.isTopMatch === (matchPayload.isTopMatch || false) &&
                        stary.vysledek_domaci === matchPayload.vysledek_domaci &&
                        stary.vysledek_hoste === matchPayload.vysledek_hoste &&
                        stary.apiStatus === (matchPayload.apiStatus || stary.apiStatus || "SCHEDULED")
                    );

                    if (!jeBezezmeny) {
                        ligaZmenena = true;
                        if (!RAM_CENTRAL_MATCHES[leagueName]) RAM_CENTRAL_MATCHES[leagueName] = {};
                        RAM_CENTRAL_MATCHES[leagueName][apiId] = {
                            ...stary,
                            ...matchPayload
                        };

                        const docRef = db.collection("ligy").doc(leagueName).collection("sezony").doc(SEZONA_ID).collection("zapasy").doc(apiId);
                        batch.set(docRef, matchPayload, { merge: true });
                        batchOpCount++;

                        if (batchOpCount >= 450) {
                            await batch.commit();
                            batch = db.batch();
                            batchOpCount = 0;
                        }
                    }
                }

                if (batchOpCount > 0) {
                    await batch.commit();
                    console.log(`💾 KALENDÁŘ DELTA [${leagueName}]: Uloženo ${batchOpCount} upravených zápasů do Firestore.`);
                } else {
                    console.log(`🛡️ KALENDÁŘ DELTA [${leagueName}]: Všechny zápasy jsou aktuální (0 Firestore zápisů).`);
                }

                if (ligaZmenena) {
                    await rekonstruujAgregatyProLigu(leagueName, true);
                }
            } catch (e) {
                console.error(`❌ Chyba kalendáře pro ${leagueName}:`, e);
            }
        }
    } finally {
        RAM_IS_SYNCING = false;
    }
    console.log("✅ Hloubková synchronizace kalendářů dokončena.");
}

// 🛡️ JEDNORÁZOVÁ PUMPA LOG TÝMŮ: Stáhne odznaky z TheSportsDB a uloží na Cloudflare R2 (podle sportu)
async function synchronizujLogaTymu() {
    console.log("=========================================================================");
    console.log("🛡️ LOGA TÝMŮ: Spouštím kontrolu a stahování oficiálních odznaků podle sportu...");
    console.log("=========================================================================");

    const dbKey = process.env.THESPORTSDB_KEY;
    if (!dbKey) {
        console.warn("⚠️ LOGA: Chybí THESPORTSDB_KEY v proměnných!");
        return;
    }

    const browserHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*"
    };

    for (const leagueName of SEZNAM_LIG) {
        const leagueConfig = LIGY_API_MAPA[leagueName];
        if (!leagueConfig || leagueConfig.provider !== "THESPORTSDB") continue;

        const isHockey = leagueName.includes("hokej") || leagueName.includes("Extraliga");
        const sportKlic = isHockey ? "ice-hockey" : "football";

        try {
            const url = `https://www.thesportsdb.com/api/v1/json/${dbKey}/search_all_teams.php?id=${leagueConfig.id}`;
            console.log(`🔎 LOGA [${leagueName} (${sportKlic})]: Dotazuji TheSportsDB API (League ID: ${leagueConfig.id})...`);
            
            const res = await fetch(url, { headers: browserHeaders, signal: AbortSignal.timeout(9000) });
            if (!res.ok) {
                console.warn(`⚠️ LOGA [${leagueName}]: API status ${res.status}`);
                continue;
            }

            const data = await res.json();
            const teams = data?.teams || [];
            console.log(`🔎 LOGA [${leagueName}]: Načteno ${teams.length} týmů.`);

            for (const team of teams) {
                const rawName = (team.strTeam || "").replace(/ Prague/g, " Praha");
                const domaci = slovnikTymu[rawName] || rawName;
                const badgeUrl = team.strBadge || team.strTeamBadge;
                if (!domaci || !badgeUrl) continue;

                const tymSlug = String(domaci).trim().toLowerCase().replace(/ /g, "_");
                const r2Key = `teams/${sportKlic}/${tymSlug}.png`;

                let exists = false;
                try {
                    await r2Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: r2Key }));
                    exists = true;
                } catch (e) {}

                if (!exists) {
                    const imgRes = await fetch(badgeUrl, { headers: browserHeaders, signal: AbortSignal.timeout(9000) });
                    if (imgRes.ok) {
                        const arrayBuffer = await imgRes.arrayBuffer();
                        await r2Client.send(new PutObjectCommand({
                            Bucket: BUCKET_NAME,
                            Key: r2Key,
                            Body: Buffer.from(arrayBuffer),
                            ContentType: "image/png",
                            CacheControl: "public, max-age=31536000, immutable"
                        }));
                        console.log(`✅ LOGA [${sportKlic}]: Uloženo logo pro ${domaci} -> ${r2Key}`);
                    }
                } else {
                    console.log(`🛡️ LOGA [${sportKlic}]: ${domaci} už na R2 existuje.`);
                }
            }
        } catch (err) {
            console.error(`❌ LOGA [${leagueName}]: Selhalo stažení log:`, err.message);
        }
    }
    console.log("🏁 LOGA: Synchronizace týmových log dokončena.");
}

// --- 🌐 LIFECYCLE INITIALIZATION BOOTSTRAP ---
async function startEnterpriseApplication() {
    console.log("=========================================================================");
    console.log("👑 CLOUD-NATIVE DAEMON: Inicializuji životní cyklus trvalého mozku...");
    console.log("=========================================================================");

    http.createServer((req, res) => {
        const url = req.url || "/";

        if (url === "/cron" || url.startsWith("/cron")) {
            console.log(`📡 PING PŘIJAT (/cron): Odpaluji Heartbeat...`);
            providniApiHeartbeat().catch(err => console.error("❌ Chyba:", err));
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("OK - Heartbeat spuštěn.");
            return;
        }

        if (url === "/sync-fixtures" || url.startsWith("/sync-fixtures")) {
            console.log(`📅 SERVISNÍ PING (/sync-fixtures): Spouštím kontrolu kalendářů...`);
            synchronizujRozpisyVsechLig().catch(err => console.error("❌ Chyba rozpisů:", err));
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("OK - Synchronizace rozpisů zahájena.");
            return;
        }

        if (url === "/sync-team-logos" || url.startsWith("/sync-team-logos")) {
            console.log(`🛡️ SERVISNÍ PING (/sync-team-logos): Spouštím kontrolu log týmů...`);
            synchronizujLogaTymu().catch(err => console.error("❌ Chyba log týmů:", err));
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("OK - Synchronizace log týmů zahájena.");
            return;
        }

        if (url === "/sync-league-graphics" || url.startsWith("/sync-league-graphics")) {
            console.log(`🏆 SERVISNÍ PING (/sync-league-graphics): Spouštím synchronizaci trofejí a stadionů...`);
            synchronizujGrafikuLig().catch(err => console.error("❌ Chyba grafiky:", err));
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("OK - Synchronizace trofejí a stadionů zahájena.");
            return;
        }

        if (url === "/sync-odds" || url.startsWith("/sync-odds")) {
            console.log(`📊 SERVISNÍ PING (/sync-odds): Spouštím Smart Sync fotbalových kurzů...`);
            smartSyncKurzu().catch(err => console.error("❌ Chyba synchronizace fotbalových kurzů:", err));
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("OK - Smart Sync fotbalových kurzů spuštěn.");
            return;
        }

        if (url === "/sync-odds-hockey" || url.startsWith("/sync-odds-hockey")) {
            console.log(`🏒 SERVISNÍ PING (/sync-odds-hockey): Spouštím Smart Sync hokejových kurzů...`);
            smartSyncKurzuHokej().catch(err => console.error("❌ Chyba synchronizace hokejových kurzů:", err));
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("OK - Smart Sync hokejových kurzů spuštěn.");
            return;
        }

        if (url === "/sync-event-map" || url.startsWith("/sync-event-map")) {
            console.log(`🗺️ SERVISNÍ PING (/sync-event-map): Spouštím měsíční generování mapy ID...`);
            synchronizujSofaScoreEventMap().catch(err => console.error("❌ Chyba mapování:", err));
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("OK - Mapování ID zahájeno.");
            return;
        }

        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("OK - Health Check v pořádku, backend mozek běží.");
    }).listen(PORT, () => {
        console.log(`🌐 HEALTH CHECK PROBE: Síťový port ${PORT} bezpečně otevřen pro Render.`);
    });

    // 1. Nejprve načteme mapu ID a existující kurzy z R2 do RAM
    await nactiEventMapZR2();
    if (Object.keys(RAM_EVENT_MAP).length === 0) {
        console.log("🗺️ INICIALIZACE: event_map.json na R2 chybí, stahuji a ukládám novou mapu...");
        await synchronizujSofaScoreEventMap();
    }
    await nactiKurzyZR2();
    await nactiProcessedDaysZR2();

    // 2. Teprve s plnou kurzovou pamětí provedeme startovní hydrataci a generování rozpisů
    await hydratujDataZFirestore();
    zapniReaktivniSluchatka();
    // ⏱️ SMYČKA 1: 30s kontrola live výsledků (Kurzy se stahují POUZE přes signál /sync-odds v pondělí)
    console.log("⏱️ AUTONOMNÍ ENGINE: Spouštím 30s smyčku pro live výsledky...");
    setInterval(() => {
        providniApiHeartbeat().catch(err => console.error("❌ Chyba interního Heartbeatu:", err));
    }, 30000);

    // 🗺️ SMYČKA 3: Měsíční mapování ID (1. den v měsíci ve 02:00 ráno)
    setInterval(() => {
        const d = new Date();
        const denVMesici = d.getDate(); // 1 = první den v měsíci
        const hodina = d.getHours();
        const minuta = d.getMinutes();

        if (denVMesici === 1 && hodina === 2 && minuta < 5) {
            console.log("⏰ ČASOVÝ TRIGGER: Spouštím měsíční generování mapy ID...");
            synchronizujSofaScoreEventMap().catch(err => console.error("❌ Chyba měsíčního mapování:", err));
        }
    }, 5 * 60 * 1000);
}

// 🏆 PUMPA TROFEJÍ A STADIONŮ: Stáhne oficiální trofeje i arény a uloží na Cloudflare R2
async function synchronizujGrafikuLig() {
    console.log("=========================================================================");
    console.log("🏆 GRAFIKA LIG: Stahuji oficiální trofeje a podklady stadionů...");
    console.log("=========================================================================");

    const dbKey = process.env.THESPORTSDB_KEY;
    if (!dbKey) return;

    const browserHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)",
        "Accept": "application/json, text/plain, */*"
    };

    const leagueKeys = {
        "Premier League": { slug: "premier_league", stadiumFallback: "https://www.thesportsdb.com/images/media/league/fanart/1b0s1515779038.jpg" },
        "Chance Liga": { slug: "chance_liga", stadiumFallback: "https://www.thesportsdb.com/images/media/team/stadium/vqrsuw1420577995.jpg" },
        "Tipsport Extraliga": { slug: "extraliga", stadiumFallback: "https://www.thesportsdb.com/images/media/team/stadium/9e78ea1578330554.jpg" },
        "MS v hokeji": { slug: "ms_hokej", stadiumFallback: "https://www.thesportsdb.com/images/media/league/fanart/uwrytu1431627961.jpg" },
        "MS ve fotbale": { slug: "ms_fotbal", stadiumFallback: "https://www.thesportsdb.com/images/media/league/fanart/wvrwxx1431627993.jpg" },
        "Liga mistrů": { slug: "liga_mistru", stadiumFallback: "https://images.unsplash.com/photo-1508098682722-e99c43a406b2?q=80&w=1600&auto=format&fit=crop" }
    };

    for (const [leagueName, cfg] of Object.entries(leagueKeys)) {
        const config = LIGY_API_MAPA[leagueName];
        if (!config || config.provider !== "THESPORTSDB") continue;

        try {
            const url = `https://www.thesportsdb.com/api/v1/json/${dbKey}/lookupleague.php?id=${config.id}`;
            const res = await fetch(url, { headers: browserHeaders, signal: AbortSignal.timeout(9000) });
            const data = res.ok ? await res.json() : null;
            const leagueObj = data?.leagues?.[0];

            // 1. Uložení trofeje s ochranou proti přepsání
            const trophyUrl = leagueObj?.strTrophy;
            if (trophyUrl) {
                const r2TrophyKey = `leagues/trophies/${cfg.slug}.png`;
                let exists = false;
                try {
                    await r2Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: r2TrophyKey }));
                    exists = true;
                } catch (e) {}

                if (!exists) {
                    const imgRes = await fetch(trophyUrl, { headers: browserHeaders, signal: AbortSignal.timeout(9000) });
                    if (imgRes.ok) {
                        const buf = await imgRes.arrayBuffer();
                        await r2Client.send(new PutObjectCommand({
                            Bucket: BUCKET_NAME,
                            Key: r2TrophyKey,
                            Body: Buffer.from(buf),
                            ContentType: "image/png",
                            CacheControl: "public, max-age=31536000, immutable"
                        }));
                        console.log(`✅ TROFEJ: ${leagueName} -> ${r2TrophyKey}`);
                    }
                } else {
                    console.log(`🛡️ TROFEJ: ${leagueName} už na R2 existuje, nepřepisuji.`);
                }
            }

            // 1b. Uložení loga soutěže (Badge) s ochranou proti nechtěnému přepsání
            const badgeUrl = leagueObj?.strBadge || leagueObj?.strLogo;
            if (badgeUrl) {
                const r2BadgeKey = `leagues/logos/${cfg.slug}.png`;
                let exists = false;
                try {
                    await r2Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: r2BadgeKey }));
                    exists = true;
                } catch (e) {}

                if (!exists) {
                    const bRes = await fetch(badgeUrl, { headers: browserHeaders, signal: AbortSignal.timeout(9000) });
                    if (bRes.ok) {
                        const bBuf = await bRes.arrayBuffer();
                        await r2Client.send(new PutObjectCommand({
                            Bucket: BUCKET_NAME,
                            Key: r2BadgeKey,
                            Body: Buffer.from(bBuf),
                            ContentType: "image/png",
                            CacheControl: "public, max-age=31536000, immutable"
                        }));
                        console.log(`✅ LOGO: ${leagueName} -> ${r2BadgeKey}`);
                    }
                } else {
                    console.log(`🛡️ LOGO: ${leagueName} už na R2 existuje, nepřepisuji.`);
                }
            }

            // 2. Uložení fotky stadionu s ochranou proti přepsání
            const stadiumUrl = leagueObj?.strFanart1 || leagueObj?.strPoster || cfg.stadiumFallback;
            if (stadiumUrl) {
                const r2StadiumKey = `leagues/stadiums/${cfg.slug}.webp`;
                let exists = false;
                try {
                    await r2Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: r2StadiumKey }));
                    exists = true;
                } catch (e) {}

                if (!exists) {
                    const sRes = await fetch(stadiumUrl, { headers: browserHeaders, signal: AbortSignal.timeout(9000) });
                    if (sRes.ok) {
                        const sBuf = await sRes.arrayBuffer();
                        await r2Client.send(new PutObjectCommand({
                            Bucket: BUCKET_NAME,
                            Key: r2StadiumKey,
                            Body: Buffer.from(sBuf),
                            ContentType: "image/webp",
                            CacheControl: "public, max-age=31536000, immutable"
                        }));
                        console.log(`🏟️ STADION: ${leagueName} -> ${r2StadiumKey}`);
                    }
                } else {
                    console.log(`🛡️ STADION: ${leagueName} už na R2 existuje, nepřepisuji.`);
                }
            }
        } catch (err) {
            console.error(`❌ GRAFIKA [${leagueName}]: Selhalo stažení:`, err.message);
        }
    }
    console.log("🏁 GRAFIKA: Synchronizace trofejí i stadionů dokončena.");
}

startEnterpriseApplication();

// =========================================================================
// 🏆 POHÁROVÝ ENGINE: TIPNI CHANCE CUP & TIPNI PREMIER CUP
// =========================================================================

function vypocitejHadíRozdeleni(sortedPlayers) {
    const groups = { A: [], B: [], C: [], D: [] };
    const groupKeys = ["A", "B", "C", "D"];
    if (!Array.isArray(sortedPlayers)) return groups;

    sortedPlayers.forEach((p, index) => {
        const round = Math.floor(index / 4);
        const pos = index % 4;
        const grpIdx = (round % 2 === 0) ? pos : (3 - pos);
        groups[groupKeys[grpIdx]].push({
            uid: p.uid,
            nick: p.nickname || p.nick || "Anonym",
            seed: index + 1,
            pts: p.celkemBodu || 0
        });
    });
    return groups;
}

function vyhodnotVitezePlayoffDuelu(p1, p2, leagueName = "Chance Liga") {
    if (p1.totalPts > p2.totalPts) return p1.uid;
    if (p2.totalPts > p1.totalPts) return p2.uid;

    if (p1.totalExact > p2.totalExact) return p1.uid;
    if (p2.totalExact > p1.totalExact) return p2.uid;

    if (p1.totalTopExact > p2.totalTopExact) return p1.uid;
    if (p2.totalTopExact > p1.totalTopExact) return p2.uid;

    if (p1.totalTend > p2.totalTend) return p1.uid;
    if (p2.totalTend > p1.totalTend) return p2.uid;

    if (leagueName === "Premier League") {
        if ((p1.totalConsolations || 0) > (p2.totalConsolations || 0)) return p1.uid;
        if ((p2.totalConsolations || 0) > (p1.totalConsolations || 0)) return p2.uid;
    }

    return p1.seed <= p2.seed ? p1.uid : p2.uid;
}

async function rekonstruujPoharProLigu(leagueName, zebricekPole, centralMatches) {
    if (leagueName !== "Chance Liga" && leagueName !== "Premier League") return;

    const isPL = leagueName === "Premier League";
    const lockRoundNum = isPL ? 9 : 11;
    const groupStartRound = isPL ? 10 : 12;
    const groupEndRound = isPL ? 19 : 18;

    const ligaKlic = String(leagueName).replace(/ /g, "_");
    const matchesList = Object.values(centralMatches || {});

    const lockRoundMatches = matchesList.filter(z => {
        const k = parseInt(String(z.kolo || "").replace(/[^0-9]/g, ""));
        return k === lockRoundNum;
    });
    const lockFinished = lockRoundMatches.length > 0 && lockRoundMatches.every(z => 
        z.vysledek_domaci !== undefined && z.vysledek_domaci !== null && z.apiStatus !== "IN_PLAY" && z.apiStatus !== "PAUSED"
    );

    const leagueDocSnap = await db.collection("ligy").doc(leagueName).get().catch(() => null);
    const lData = leagueDocSnap && leagueDocSnap.exists ? leagueDocSnap.data() : {};
    let lockedData = lData.cupLock || null;

    if (lockFinished && !lockedData && zebricekPole.length > 0) {
        console.log(`🔒 CUP LOCK TRIGGER [${leagueName}]: ${lockRoundNum}. kolo dohráno! Zamykám složení skupin Poháru.`);
        const lockedDraft = vypocitejHadíRozdeleni(zebricekPole);
        lockedData = {
            status: "GROUPS_LOCKED",
            lockedAtRound: lockRoundNum,
            lockedAt: new Date().toISOString(),
            initialGroups: lockedDraft
        };
        await db.collection("ligy").doc(leagueName).set({ cupLock: lockedData }, { merge: true }).catch(e => console.error("❌ Chyba zápisu cup_lock:", e));
    }

    const isGroupsLocked = Boolean(lockedData && lockedData.initialGroups);
    const status = isGroupsLocked ? "GROUPS_LOCKED" : "PREVIEW";

    const groupsDraft = isGroupsLocked ? lockedData.initialGroups : vypocitejHadíRozdeleni(zebricekPole);
    const finalGroups = { A: [], B: [], C: [], D: [] };

    const groupStageMatches = matchesList.filter(z => {
        const kNum = parseInt(String(z.kolo || "").replace(/[^0-9]/g, ""));
        return kNum >= groupStartRound && kNum <= groupEndRound;
    });

    for (const grpKey of ["A", "B", "C", "D"]) {
        const members = groupsDraft[grpKey] || [];

        finalGroups[grpKey] = members.map(m => {
            let pts = 0;
            let exact = 0;
            let topExact = 0;
            let tend = 0;
            let consolations = 0;

            if (isGroupsLocked && groupStageMatches.length > 0) {
                const uSouteze = RAM_USERS_TIPS[m.uid] || {};
                const uTips = (uSouteze[ligaKlic] && uSouteze[ligaKlic].tipy) ? uSouteze[ligaKlic].tipy : {};

                groupStageMatches.forEach(zap => {
                    const isEvaluated = zap.vysledek_domaci !== undefined && zap.vysledek_domaci !== null;
                    if (!isEvaluated) return;

                    const uTip = uTips[zap.id || zap.matchId];
                    if (uTip) {
                        const b = vypocitejBodyZapasuLocal(uTip.tip_domaci, uTip.tip_hoste, zap.vysledek_domaci, zap.vysledek_hoste, uTip.postup, zap.postup, zap.isPlayoff, zap.isTopMatch, leagueName);
                        pts += b;

                        const tD = parseInt(uTip.tip_domaci); const tH = parseInt(uTip.tip_hoste);
                        const rD = parseInt(zap.vysledek_domaci); const rH = parseInt(zap.vysledek_hoste);
                        if (tD === rD && tH === rH) {
                            exact++;
                            if (zap.isTopMatch) topExact++;
                        }
                        if ((tD > tH && rD > rH) || (tD < tH && rD < rH) || (tD === tH && rD === rH)) {
                            tend++;
                        }
                        if (isPL && (tD === rD || tH === rH)) {
                            consolations++;
                        }
                    }
                });
            } else {
                const pOff = zebricekPole.find(p => p.uid === m.uid);
                pts = pOff ? pOff.celkemBodu : (m.pts || 0);
            }

            return {
                uid: m.uid,
                nick: m.nick || m.nickname,
                seed: m.seed || m.originalRank || 1,
                pts: pts,
                exact: exact,
                topExact: topExact,
                tend: tend,
                consolations: consolations
            };
        });

        finalGroups[grpKey].sort((a, b) => {
            if (isGroupsLocked) {
                if (b.pts !== a.pts) return b.pts - a.pts;
                if (b.exact !== a.exact) return b.exact - a.exact;
                if (b.topExact !== a.topExact) return b.topExact - a.topExact;
                if (b.tend !== a.tend) return b.tend - a.tend;
                if (isPL && b.consolations !== a.consolations) return b.consolations - a.consolations;
                return a.seed - b.seed;
            }
            return a.seed - b.seed;
        });
    }

    let secondPlacesRank = [];
    if (!isPL && isGroupsLocked) {
        ["A", "B", "C", "D"].forEach(grpKey => {
            const grp = finalGroups[grpKey];
            if (grp.length >= 2) {
                secondPlacesRank.push({
                    ...grp[1],
                    group: grpKey
                });
            }
        });

        secondPlacesRank.sort((a, b) => {
            if (b.pts !== a.pts) return b.pts - a.pts;
            if (b.exact !== a.exact) return b.exact - a.exact;
            if (b.topExact !== a.topExact) return b.topExact - a.topExact;
            if (b.tend !== a.tend) return b.tend - a.tend;
            return a.seed - b.seed;
        });

        secondPlacesRank = secondPlacesRank.map((p, idx) => ({
            ...p,
            rank: idx + 1,
            qualifiedToTop6: idx < 2
        }));
    }

    const playoffData = sestavPlayoffPavouka(leagueName, finalGroups, secondPlacesRank, matchesList);

    const cupJson = {
        leagueName: leagueName,
        status: playoffData ? "PLAYOFF" : status,
        lockedAtRound: isGroupsLocked ? lockRoundNum : null,
        groups: finalGroups,
        secondPlacesRank: secondPlacesRank,
        playoff: playoffData,
        aktualizovano: new Date().toISOString()
    };

    await uploadToR2(leagueName, "cup.json", cupJson);
}

function sestavPlayoffPavouka(leagueName, finalGroups, secondPlacesRank, matchesList) {
    const isPL = leagueName === "Premier League";
    const groupEndRound = isPL ? 19 : 18;

    const rEndMatches = matchesList.filter(z => parseInt(String(z.kolo || '').replace(/[^0-9]/g, '')) === groupEndRound);
    const rEndFinished = rEndMatches.length > 0 && rEndMatches.every(z => z.vysledek_domaci !== undefined && z.apiStatus !== 'IN_PLAY');

    if (!rEndFinished) return null;

    const getPlayerRoundStats = (uid, roundNum) => {
        const uSouteze = RAM_USERS_TIPS[uid] || {};
        const ligaKlic = String(leagueName).replace(/ /g, '_');
        const uTips = (uSouteze[ligaKlic] && uSouteze[ligaKlic].tipy) ? uSouteze[ligaKlic].tipy : {};

        const roundMatches = matchesList.filter(z => parseInt(String(z.kolo || '').replace(/[^0-9]/g, '')) === roundNum);
        let pts = 0, exact = 0, topExact = 0, tend = 0, consolations = 0;
        let isStarted = false;

        roundMatches.forEach(zap => {
            if (zap.vysledek_domaci !== undefined) {
                isStarted = true;
                const tip = uTips[zap.id || zap.matchId];
                if (tip) {
                    pts += vypocitejBodyZapasuLocal(tip.tip_domaci, tip.tip_hoste, zap.vysledek_domaci, zap.vysledek_hoste, tip.postup, zap.postup, zap.isPlayoff, zap.isTopMatch, leagueName);
                    const td = parseInt(tip.tip_domaci); const th = parseInt(tip.tip_hoste);
                    const rd = parseInt(zap.vysledek_domaci); const rh = parseInt(zap.vysledek_hoste);
                    if (td === rd && th === rh) {
                        exact++;
                        if (zap.isTopMatch) topExact++;
                    }
                    if ((td > th && rd > rh) || (td < th && rd < rh) || (td === th && rd === rh)) {
                        tend++;
                    }
                    if (isPL && (td === rd || th === rh)) {
                        consolations++;
                    }
                }
            }
        });

        return { pts, exact, topExact, tend, consolations, isStarted };
    };

    if (isPL) {
        const g1 = ['A', 'B', 'C', 'D'].map(k => finalGroups[k]?.[0]).filter(Boolean).sort((a,b) => b.pts - a.pts || a.seed - b.seed);
        const g2 = ['A', 'B', 'C', 'D'].map(k => finalGroups[k]?.[1]).filter(Boolean).sort((a,b) => b.pts - a.pts || a.seed - b.seed);
        const g3 = ['A', 'B', 'C', 'D'].map(k => finalGroups[k]?.[2]).filter(Boolean).sort((a,b) => b.pts - a.pts || a.seed - b.seed);
        const g4 = ['A', 'B', 'C', 'D'].map(k => finalGroups[k]?.[3]).filter(Boolean).sort((a,b) => b.pts - a.pts || a.seed - b.seed);
        const g5 = ['A', 'B', 'C', 'D'].map(k => finalGroups[k]?.[4]).filter(Boolean).sort((a,b) => b.pts - a.pts || a.seed - b.seed);

        const fullSeedingPL = [
            ...g1.map((p, i) => ({ ...p, generalSeed: i + 1 })),
            ...g2.map((p, i) => ({ ...p, generalSeed: i + 5 })),
            ...g3.map((p, i) => ({ ...p, generalSeed: i + 9 })),
            ...g4.map((p, i) => ({ ...p, generalSeed: i + 13 })),
            ...g5.map((p, i) => ({ ...p, generalSeed: i + 17 }))
        ];

        const pr1Duels = [];
        for (let i = 0; i < 4; i++) {
            const p1 = fullSeedingPL[12 + i];
            const p2 = fullSeedingPL[19 - i];

            const p1L1 = getPlayerRoundStats(p1?.uid, 21);
            const p1L2 = getPlayerRoundStats(p1?.uid, 22);
            const p2L1 = getPlayerRoundStats(p2?.uid, 21);
            const p2L2 = getPlayerRoundStats(p2?.uid, 22);

            const p1Obj = {
                uid: p1?.uid, nick: p1?.nick, seed: p1?.generalSeed,
                leg1: p1L1.isStarted ? p1L1.pts : null, leg2: p1L2.isStarted ? p1L2.pts : null,
                totalPts: (p1L1.pts || 0) + (p1L2.pts || 0),
                totalExact: p1L1.exact + p1L2.exact, totalTopExact: p1L1.topExact + p1L2.topExact, totalTend: p1L1.tend + p1L2.tend, totalConsolations: p1L1.consolations + p1L2.consolations
            };
            const p2Obj = {
                uid: p2?.uid, nick: p2?.nick, seed: p2?.generalSeed,
                leg1: p2L1.isStarted ? p2L1.pts : null, leg2: p2L2.isStarted ? p2L2.pts : null,
                totalPts: (p2L1.pts || 0) + (p2L2.pts || 0),
                totalExact: p2L1.exact + p2L2.exact, totalTopExact: p2L1.topExact + p2L2.topExact, totalTend: p2L1.tend + p2L2.tend, totalConsolations: p2L1.consolations + p2L2.consolations
            };

            const isFinished = p1L2.isStarted && p2L2.isStarted;
            const winnerUid = isFinished ? vyhodnotVitezePlayoffDuelu(p1Obj, p2Obj, leagueName) : null;

            pr1Duels.push({
                duelId: `PR1_${i + 1}`,
                title: `1. Předkolo ${i + 1}`,
                statusText: isFinished ? 'DOHRÁNO ✓' : (p1L1.isStarted ? 'ODVETA ⏳' : 'ČEKÁ NA VÝKOP'),
                p1: p1Obj, p2: p2Obj, winnerUid: winnerUid
            });
        }

        return {
            rounds: [
                {
                    name: "🥊 1. PŘEDKOLO (21. & 22. KOLO)",
                    info: "4. vs. 5. místa ze skupin (Dvojzápas)",
                    isSingleMatch: false,
                    duels: pr1Duels
                }
            ]
        };
    } else {
        const top4Winners = ['A', 'B', 'C', 'D'].map(k => finalGroups[k]?.[0]).filter(Boolean).sort((a, b) => b.pts - a.pts || a.seed - b.seed);
        const top2Seconds = secondPlacesRank.filter(sp => sp.qualifiedToTop6);
        const other2Seconds = secondPlacesRank.filter(sp => !sp.qualifiedToTop6);

        const restOfPlayers = [];
        ['A', 'B', 'C', 'D'].forEach(k => {
            const grp = finalGroups[k] || [];
            for (let i = 2; i < grp.length; i++) {
                restOfPlayers.push(grp[i]);
            }
        });
        restOfPlayers.push(...other2Seconds);
        restOfPlayers.sort((a, b) => b.pts - a.pts || a.seed - b.seed);

        const fullSeedingCL = [
            ...top4Winners.map((p, i) => ({ ...p, generalSeed: i + 1 })),
            ...top2Seconds.map((p, i) => ({ ...p, generalSeed: i + 5 })),
            ...restOfPlayers.map((p, i) => ({ ...p, generalSeed: i + 7 }))
        ];

        const preRoundDuels = [];
        for (let i = 0; i < 10; i++) {
            const p1Seed = fullSeedingCL[6 + i];
            const p2Seed = fullSeedingCL[25 - i];

            const p1L1 = getPlayerRoundStats(p1Seed?.uid, 19);
            const p1L2 = getPlayerRoundStats(p1Seed?.uid, 20);
            const p2L1 = getPlayerRoundStats(p2Seed?.uid, 19);
            const p2L2 = getPlayerRoundStats(p2Seed?.uid, 20);

            const p1Obj = {
                uid: p1Seed?.uid, nick: p1Seed?.nick, seed: p1Seed?.generalSeed,
                leg1: p1L1.isStarted ? p1L1.pts : null, leg2: p1L2.isStarted ? p1L2.pts : null,
                totalPts: (p1L1.pts || 0) + (p1L2.pts || 0),
                totalExact: p1L1.exact + p1L2.exact, totalTopExact: p1L1.topExact + p1L2.topExact, totalTend: p1L1.tend + p1L2.tend
            };
            const p2Obj = {
                uid: p2Seed?.uid, nick: p2Seed?.nick, seed: p2Seed?.generalSeed,
                leg1: p2L1.isStarted ? p2L1.pts : null, leg2: p2L2.isStarted ? p2L2.pts : null,
                totalPts: (p2L1.pts || 0) + (p2L2.pts || 0),
                totalExact: p2L1.exact + p2L2.exact, totalTopExact: p2L1.topExact + p2L2.topExact, totalTend: p2L1.tend + p2L2.tend
            };

            const isFinished = p1L2.isStarted && p2L2.isStarted;
            const winnerUid = isFinished ? vyhodnotVitezePlayoffDuelu(p1Obj, p2Obj, leagueName) : null;

            preRoundDuels.push({
                duelId: `PR_${i + 1}`,
                title: `Předkolo ${i + 1}`,
                statusText: isFinished ? 'DOHRÁNO ✓' : (p1L1.isStarted ? 'ODVETA ⏳' : 'ČEKÁ NA VÝKOP'),
                p1: p1Obj, p2: p2Obj, winnerUid: winnerUid
            });
        }

        return {
            rounds: [
                {
                    name: "🥊 PŘEDKOLO (19. & 20. KOLO)",
                    info: "Dvouzápasový souboj (Doma / Odveta)",
                    isSingleMatch: false,
                    duels: preRoundDuels
                }
            ]
        };
    }
}
