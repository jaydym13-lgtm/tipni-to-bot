// =========================================================================
// 🤖 TIPNI TO! - TRVALÝ STAVOVÝ BACKEND DAEMON V2.5.0 (bot.mjs)
// =========================================================================
import admin from "firebase-admin";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import process from "process";
import http from "http";

import { PRAVIDLA_LIG } from "./rules.js";

// --- ⚙️ PROSTŘEDÍ A MULTI-LEAGUE KONFIGURACE ---
const SEZONA_ID = process.env.SEZONA_ID || "2026_2027";
const PORT = process.env.PORT || 8080;

// 🗺️ ČÍSELNÍK SPORTOVNÍCH API PROVIDERŮ A ID SOUTĚŽÍ
const LIGY_API_MAPA = {
    "Chance Liga": { id: "4631", provider: "THESPORTSDB" },
    "Premier League": { id: "4328", provider: "THESPORTSDB" },
    "MS ve fotbale": { id: "4429", provider: "THESPORTSDB" },
    "Tipsport Extraliga": { id: "4923", provider: "THESPORTSDB" },
    "MS v hokeji": { id: "4859", provider: "THESPORTSDB" }
};

// Seznam lig, které má bot v tomto běhu živě obsluhovat
const SEZNAM_LIG = (process.env.ACTIVE_LEAGUES || "Chance Liga,Premier League,MS ve fotbale,Tipsport Extraliga,MS v hokeji")
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

// 📊 RAM MEZIPAMĚŤ KURZŮ Z API-SPORTS
const RAM_CENTRAL_ODDS = {};

// 🗺️ ČÍSELNÍK SOUTĚŽÍ PRO API-SPORTS (Kurzy Bet365)
const API_SPORTS_MAPA = {
    "Chance Liga": { id: 345, sport: "football" },
    "Premier League": { id: 39, sport: "football" },
    "MS ve fotbale": { id: 1, sport: "football" },
    "Tipsport Extraliga": { id: 47, sport: "hockey" },
    "MS v hokeji": { id: 1, sport: "hockey" }
};

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
    const poslednich5 = odehrane.slice(0, 5);
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

// 🌐 HLOUBKOVÁ SMYČKA: STAŽENÍ KURZŮ BET365 Z API-SPORTS
async function synchronizujKurzyVsechLig() {
    const apiKey = process.env.API_SPORTS_KEY;
    if (!apiKey) {
        console.log("ℹ️ API_SPORTS_KEY není nastaven v env proměnných. Přeskakuji kurzy.");
        return;
    }

    const sezoneYear = parseInt(String(SEZONA_ID).split('_')[0], 10) || 2026;

    for (const leagueName of SEZNAM_LIG) {
        const cfg = API_SPORTS_MAPA[leagueName];
        if (!cfg) continue;

        try {
            const isHockey = cfg.sport === "hockey";
            const baseUrl = isHockey ? "https://v1.hockey.api-sports.io" : "https://v3.football.api-sports.io";
            const targetUrl = `${baseUrl}/odds?league=${cfg.id}&season=${sezoneYear}`;

            const res = await fetch(targetUrl, {
                headers: {
                    "x-apisports-key": apiKey,
                    "User-Agent": "TipniToBot/1.0"
                },
                signal: AbortSignal.timeout(9000)
            });

            if (!res.ok) {
                console.log(`⚠️ API-Sports (${leagueName}) status: ${res.status}`);
                continue;
            }

            const data = await res.json();
            const oddsItems = data.response || [];
            if (!RAM_CENTRAL_ODDS[leagueName]) RAM_CENTRAL_ODDS[leagueName] = {};

            oddsItems.forEach(item => {
                const homeRaw = item.teams?.home?.name || "";
                const awayRaw = item.teams?.away?.name || "";
                const dTrans = slovnikTymu[homeRaw] || homeRaw;
                const hTrans = slovnikTymu[awayRaw] || awayRaw;
                const key = `${PL_NORM(dTrans)} vs ${PL_NORM(hTrans)}`;

                const bmakers = item.bookmakers || [];
                const bmaker = bmakers.find(b => String(b.name || '').toLowerCase().includes('bet365')) || bmakers[0];
                if (!bmaker) return;

                const bet = (bmaker.bets || []).find(b => b.id === 1 || String(b.name || '').toLowerCase().includes('winner'));
                if (!bet || !bet.values) return;

                const v1 = bet.values.find(v => v.value === "Home" || v.value === "1");
                const vX = bet.values.find(v => v.value === "Draw" || v.value === "X");
                const v2 = bet.values.find(v => v.value === "Away" || v.value === "2");

                if (v1 && v2) {
                    RAM_CENTRAL_ODDS[leagueName][key] = {
                        "1": parseFloat(v1.odd),
                        "X": vX ? parseFloat(vX.odd) : null,
                        "2": parseFloat(v2.odd),
                        bookmaker: bmaker.name || "Bet365"
                    };
                }
            });

            console.log(`📊 KURZY [${leagueName}]: Načteno ${Object.keys(RAM_CENTRAL_ODDS[leagueName] || {}).length} kurzů z API-Sports.`);
        } catch (e) {
            console.error(`❌ Chyba stahování kurzů pro ${leagueName}:`, e.message);
        }
        await new Promise(r => setTimeout(r, 600));
    }
}

// 🎛️ GLOBÁLNÍ DYNAMICKÁ KONFIGURACE (Ovládaná ze Super Admin panelu přes Firestore)
const RAM_BOT_CONFIG = {
    active: true,         // Hlavní nouzový vypínač bota
    liveInterval: 1,      // 1 minuta pro live skóre (Patreon Tier)
    waitInterval: 10      // 10 minut pro čekání
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
    "Zbrojovka Brno": "Zbrojovka Brno", "FC Zbrojovka Brno": "Zbrojovka Brno",
    "Artis Brno": "Artis Brno", "SK Líšeň": "Artis Brno",
    // 🏴󠁧󠁢󠁥󠁮󠁧󠁿 PREMIER LEAGUE 2026/2027 - KRÁTKÉ ČESKÉ NÁZVY
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

    // 🏒 TIPSPORT EXTRALIGA 2026/2027 - KRÁTKÉ ČESKÉ NÁZVY
    "HC Sparta Praha": "Sparta", "Sparta Praha": "Sparta",
    "HC Dynamo Pardubice": "Pardubice", "Dynamo Pardubice": "Pardubice",
    "HC Oceláři Třinec": "Třinec", "Oceláři Třinec": "Třinec",
    "HC VÍTKOVICE RIDERA": "Vítkovice", "HC Vitkovice Ridera": "Vítkovice", "HC Vítkovice": "Vítkovice",
    "Bílí Tygři Liberec": "Liberec", "Bili Tygri Liberec": "Liberec",
    "HC Kometa Brno": "Brno", "Kometa Brno": "Brno",
    "Mountfield HK": "Hr. Králové", "Mountfield Hradec Kralove": "Hr. Králové",
    "HC VERVA Litvínov": "Litvínov", "HC Verva Litvinov": "Litvínov",
    "HC Olomouc": "Olomouc",
    "BK Mladá Boleslav": "Ml. Boleslav", "BK Mlada Boleslav": "Ml. Boleslav",
    "HC Škoda Plzeň": "Plzeň", "HC Skoda Plzen": "Plzeň",
    "HC Energie Karlovy Vary": "K. Vary", "Energie Karlovy Vary": "K. Vary", "Karlovy Vary": "K. Vary",
    "Rytíři Kladno": "Kladno", "Rytiri Kladno": "Kladno",
    "Banes Motor České Budějovice": "Č. Budějovice", "HC Motor České Budějovice": "Č. Budějovice", "Motor České Budějovice": "Č. Budějovice"
};

// --- 🧮 POSVÁTNÁ MATEMATIKA BODŮ ---
const vypocitejBodyZapasuLocal = (tipDomaci, tipHoste, realDomaci, realHoste, tipPostup, realPostup, isPlayoff, isTopMatch = false, leagueName = "DEFAULT") => {
    const tDom = parseInt(tipDomaci); const tHos = parseInt(tipHoste);
    const rDom = parseInt(realDomaci); const rHos = parseInt(realHoste);
    if (isNaN(tDom) || isNaN(tHos) || isNaN(rDom) || isNaN(rHos)) return 0;

    const pravidla = PRAVIDLA_LIG[leagueName] || PRAVIDLA_LIG["DEFAULT"];
    let ziskaneBody = 0;

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

// --- 📤 DISTRIBUČNÍ SYSTÉM (R2 UPLOAD) ---
// --- 📤 DISTRIBUČNÍ SYSTÉM (R2 UPLOAD S ZÁMKEM PARALELNÍCH ZÁPISŮ A DEBOUNCEREM) ---
const activeR2Uploads = new Set();

async function uploadToR2(leagueName, filename, jsonData) {
    const ligaKlic = String(leagueName).replace(/ /g, "_");
    const dynamicPath = `sezony/${SEZONA_ID}/${ligaKlic}/${filename}`;

    // 🛡️ OCHRANNÝ JISTIČ PARALELIZMU: Čekáme na dokončení probíhajícího uploadu pro stejný objekt
    while (activeR2Uploads.has(dynamicPath)) {
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    activeR2Uploads.add(dynamicPath);

    try {
        await new Promise(resolve => setTimeout(resolve, 300));
        const bodyText = JSON.stringify(jsonData, null, 2);
        await r2Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: dynamicPath,
            Body: bodyText,
            ContentType: "application/json"
        }));
    } catch (err) {
        console.error(`❌ Chyba distribuce souboru ${filename} (${leagueName}) do R2:`, err);
    } finally {
        activeR2Uploads.delete(dynamicPath);
    }
}

// ⏱️ DEBOUNCE JISTIČ: Slučuje smršť Firestore událostí do jediného klidného zápisu
let rekonstrukceTimer = null;
let forceHistoryPending = false;

function planujRekonstrukciAgregatu(forceWriteHistory = false) {
    if (forceWriteHistory) forceHistoryPending = true;

    if (rekonstrukceTimer) {
        clearTimeout(rekonstrukceTimer);
    }

    rekonstrukceTimer = setTimeout(async () => {
        const historyFlag = forceHistoryPending;
        forceHistoryPending = false;
        rekonstrukceTimer = null;
        await rekonstruujAgregatyVsechny(historyFlag);
    }, 1500);
}

// --- 📡 DETERMINISTICKÁ HYDRATACE A REAKTIVNÍ STREAMY ---
let jeInicializovano = false;

// 1. KROK: Jednorázové načtení 100 % všech dat do RAM při startu (přesně 1 běh bez časovačů)
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

    for (const leagueName of SEZNAM_LIG) {
        if (!RAM_CENTRAL_MATCHES[leagueName]) RAM_CENTRAL_MATCHES[leagueName] = {};
        const zapasySnap = await db.collection("ligy").doc(leagueName).collection("sezony").doc(SEZONA_ID).collection("zapasy").get();
        zapasySnap.forEach(docSnap => {
            const matchId = docSnap.id;
            const data = docSnap.data() || {};
            let isoDatum = new Date().toISOString();
            if (data.datum) {
                isoDatum = typeof data.datum.toDate === 'function' ? data.datum.toDate().toISOString() : new Date(data.datum).toISOString();
            }
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
                postup: data.postup || ""
            };
        });
    }

    console.log("🚀 Všechna data jsou kompletně v RAM. Spouštím úvodní synchronizaci na R2...");
    await rekonstruujAgregatyVsechny(true);
    jeInicializovano = true;
    console.log("✅ Úvodní synchronizace R2 dokončena. Zapínám reaktivní hlídače pro další změny.");
}

// 2. KROK: Zapnutí živých sluchátek pro sledování změn za běhu
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
            if (!jeInicializovano) return;
            snapshot.docChanges().forEach(change => {
                const matchId = change.doc.id;
                const data = change.doc.data() || {};
                if (change.type === "removed") {
                    if (RAM_CENTRAL_MATCHES[leagueName]) delete RAM_CENTRAL_MATCHES[leagueName][matchId];
                } else {
                    if (!RAM_CENTRAL_MATCHES[leagueName]) RAM_CENTRAL_MATCHES[leagueName] = {};
                    const stary = RAM_CENTRAL_MATCHES[leagueName][matchId] || {};
                    let isoDatum = stary.datum || new Date().toISOString();
                    if (data.datum) {
                        isoDatum = typeof data.datum.toDate === 'function' ? data.datum.toDate().toISOString() : new Date(data.datum).toISOString();
                    }
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
                        postup: data.postup || stary.postup || ""
                    };
                }
            });
            planujRekonstrukciAgregatu();
        }, err => console.error(`❌ Chyba streamu zápasů pro ${leagueName}:`, err));
    });
}

// --- 🧮 AGREGÁTOR PAMĚTI ---
async function rekonstruujAgregatyVsechny(forceWriteHistory = false) {
    for (const leagueName of SEZNAM_LIG) {
        await rekonstruujAgregatyProLigu(leagueName, forceWriteHistory);
    }
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

const PL_NORM = (str) => String(str || '').toLowerCase().trim();

const PL_URCI_KOS = (tym) => {
    const t = PL_NORM(tym);
    if (PL_BASKETS.basket1.some(x => t.includes(x) || x.includes(t))) return 1;
    if (PL_BASKETS.basket2.some(x => t.includes(x) || x.includes(t))) return 2;
    return 3;
};

// RAM Paměť minulého návrhu bota na pozadí pro Páku 3
const RAM_PREV_TOP_MATCH_IDS = {};

// 🤖 AUTONOMNÍ FAIR-PLAY GENERÁTOR TOP ZÁPASŮ
async function autoGenerujTopZapasyProLigu(leagueName, realLeagueData) {
    const pravidla = PRAVIDLA_LIG[leagueName];
    if (!pravidla || !pravidla.hasTopMatch) return;

    // 🛑 SPRÁVNÍ VYPNUTÍ Z ADMIN PANELU
    if (realLeagueData && realLeagueData.hasTopMatch === false) {
        return;
    }

    const centralMatches = RAM_CENTRAL_MATCHES[leagueName] || {};
    const zapasyPole = Object.entries(centralMatches).map(([id, z]) => ({ ...z, id }));
    if (zapasyPole.length === 0) return;

    // Seskupení zápasů podle kol
    const kolaMap = {};
    zapasyPole.forEach(z => {
        const k = String(z.kolo || "Šampionát").trim();
        if (!kolaMap[k]) kolaMap[k] = [];
        kolaMap[k].push(z);
    });

    const seznamKol = Object.keys(kolaMap);
    const totalRounds = seznamKol.length;

    // 🛑 KONTROLA: Pokud už každé kolo má přesně 1 TOP zápas (např. nastaveno ručně z adminu), bot nic nemění!
    let plnePokryto = true;
    for (const [koloNazev, zapasyVKole] of Object.entries(kolaMap)) {
        const topInRound = zapasyVKole.filter(z => z.isTopMatch);
        if (topInRound.length !== 1) {
            plnePokryto = false;
            break;
        }
    }

    if (plnePokryto) return;

    // =========================================================================
    // ⚡ PREMIER LEAGUE - KASKÁDOVÝ BOT GENERÁTOR SE 3 PÁKAMI VARIABILITY
    // =========================================================================
    if (leagueName === "Premier League") {
        console.log(`⚡ BOT DAEMON [${leagueName}]: Generuji neprůstřelný rozpis TOP zápasů (${totalRounds} kol)...`);

        // PÁKA 3: Blokování 2-3 zápasů z minulého návrhu
        const prevProposalIds = RAM_PREV_TOP_MATCH_IDS[leagueName] || [];
        const bannedMatchIds = new Set();
        if (prevProposalIds.length > 0) {
            const shufflePrev = [...prevProposalIds].sort(() => Math.random() - 0.5);
            const banCount = Math.floor(Math.random() * 2) + 2;
            for (let b = 0; b < Math.min(banCount, shufflePrev.length); b++) {
                bannedMatchIds.add(shufflePrev[b]);
            }
        }

        // PÁKA 2: Týmový Seed bonus v RAM
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

            // PÁKA 1: Priority Shuffle zamíchá kola se stejným počtem možností
            const prioritizedRounds = [...roundData].sort((a, b) => {
                if (a.strictCount !== b.strictCount) {
                    return a.strictCount - b.strictCount;
                }
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

                        // 🛑 ABSOLUTNÍ ČERVENÁ LINIE
                        if ((kosD === 1 && kosH === 3) || (kosD === 3 && kosH === 1)) continue;
                        if (cD >= 4 || cH >= 4) continue;
                        if (odehraneDvojice.has(dvojiceKlic)) continue;

                        // Tier 1: Ideální stav (vnitro-košové + cooldown 3+)
                        if (tier === 1) {
                            if (kosD !== kosH) continue;
                            if (tymPosledniKolo[d] !== undefined && Math.abs(rIdx - tymPosledniKolo[d]) < 3) continue;
                            if (tymPosledniKolo[h] !== undefined && Math.abs(rIdx - tymPosledniKolo[h]) < 3) continue;
                        }
                        // Tier 2: Mírnější cooldown (2 kola)
                        else if (tier === 2) {
                            if (kosD !== kosH) continue;
                            if (tymPosledniKolo[d] !== undefined && Math.abs(rIdx - tymPosledniKolo[d]) < 2) continue;
                            if (tymPosledniKolo[h] !== undefined && Math.abs(rIdx - tymPosledniKolo[h]) < 2) continue;
                        }
                        // Tier 3: Nouzový mix B2 vs B3
                        else if (tier === 3) {
                            if (kosD === 1 || kosH === 1) continue;
                            if (!((kosD === 2 && kosH === 3) || (kosD === 3 && kosH === 2))) continue;
                            if (tymPosledniKolo[d] !== undefined && Math.abs(rIdx - tymPosledniKolo[d]) < 2) continue;
                            if (tymPosledniKolo[h] !== undefined && Math.abs(rIdx - tymPosledniKolo[h]) < 2) continue;
                        }
                        // Tier 4: Záchranný pás
                        else if (tier === 4) {
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

            // Zápis změn do Firestore a synchronizace RAM daemona
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
            console.log(`✅ BOT DAEMON [${leagueName}]: Rozpis TOP zápasů úspěšně nastaven a synchronizován do Firestore.`);
            return;
        }
    }

    // =========================================================================
    // GENERICKÁ POJISTKA PRO OSTATNÍ LIGY (Chance Liga, Extraliga, atd.)
    // =========================================================================
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

// =========================================================================
// 💡 SPOLEČNÝ ANALYTICKÝ MOZEK RADARU (BLESKOVÝ VÝPOČET Z RAM)
// =========================================================================
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
            smolarSezony: null
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

    let celkemTipuSezもっと = 0;
    let celkemSpravnychTendenci = 0;
    let celkemPresnychTref = 0;

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
            celkemTipuSezもっと++;

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

        // 1. 💀 Totální výbuch (Tipovalo se, ale nikdo nezískal ani bod)
        if (tipovaloLidi > 0 && hraciSBody.length === 0) {
            totalniVybuchy.push({
                zapas: zapasLabel,
                kolo: koloLabel,
                datum: zapas.datum
            });
        }

        // 2. 🐺 Vlk samotář (Právě 1 hráč z ligy bodoval)
        if (tipovaloLidi > 1 && hraciSBody.length === 1) {
            vlciSamotari.push({
                zapas: zapasLabel,
                kolo: koloLabel,
                hrac: hraciSBody[0].nick,
                body: hraciSBody[0].body,
                datum: zapas.datum
            });
        }

        // 3. 💰 Zlatý důl (Absolutní bodový festival)
        if (celkemBoduZapasu > maxRozdanoBodu || (celkemBoduZapasu === maxRozdanoBodu && zlatyDul && presnychZasahu > zlatyDul.presnych)) {
            maxRozdanoBodu = celkemBoduZapasu;
            zlatyDul = {
                zapas: zapasLabel,
                kolo: koloLabel,
                rozdanoBodu: celkemBoduZapasu,
                presnych: presnychZasahu
            };
        }
    });

    // 🏟️ Seřazení kompletní tabulky štědrosti klubů
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

    // 🔮 Přání vs. Realita
    const sortedTipy = Object.entries(cetnostTipu).sort((a, b) => b[1] - a[1]);
    const topTip = sortedTipy[0] ? sortedTipy[0][0] : "–";
    const topTipCount = sortedTipy[0] ? sortedTipy[0][1] : 0;
    const topTipPct = celkemTipuSezもっと > 0 ? Math.round((topTipCount / celkemTipuSezもっと) * 100) : 0;

    const sortedVysledky = Object.entries(cetnostVysledku).sort((a, b) => b[1] - a[1]);
    const topVysledek = sortedVysledky[0] ? sortedVysledky[0][0] : "–";
    const topVysledekCount = sortedVysledky[0] ? sortedVysledky[0][1] : 0;
    const topVysledekPct = odehraneZapasy.length > 0 ? Math.round((topVysledekCount / odehraneZapasy.length) * 100) : 0;

    // 🩹 Smolař sezóny
    let nejSmolarUid = null;
    let maxSmula = 0;
    Object.entries(smolariMap).forEach(([uid, count]) => {
        if (count > maxSmula) {
            maxSmula = count;
            nejSmolarUid = uid;
        }
    });

    return {
        totalniVybuchy: totalniVybuchy.reverse(), // Nejnovější nahoře
        vlciSamotari: vlciSamotari.reverse(),     // Nejnovější nahoře
        zlatyDul: zlatyDul,
        stedrostKlubu: stedrostKlubu,
        nejcastejsiTip: topTip,
        nejcastejsiTipPct: topTipPct,
        nejcastejsiVysledek: topVysledek,
        nejcastejsiVysledekPct: topVysledekPct,
        uspesnostTendencePct: celkemTipuSezもっと > 0 ? Math.round((celkemSpravnychTendenci / celkemTipuSezもっと) * 100) : 0,
        uspesnostPresnePct: celkemTipuSezもっと > 0 ? Math.round((celkemPresnychTref / celkemTipuSezもっと) * 100) : 0,
        smolarSezony: nejSmolarUid ? { nick: uzivateleProfily[nejSmolarUid]?.nickname, pocet: maxSmula } : null
    };
}

async function rekonstruujAgregatyProLigu(leagueName, forceWriteHistory = false) {
    const ligaKlic = String(leagueName).replace(/ /g, "_");
    const centralMatches = RAM_CENTRAL_MATCHES[leagueName] || {};

    const leagueDoc = await db.collection("ligy").doc(leagueName).get().catch(() => null);
    const realLeagueData = leagueDoc && leagueDoc.exists ? leagueDoc.data() : null;

    // Generátor zavoláme až po načtení nastavení z Firestore
    await autoGenerujTopZapasyProLigu(leagueName, realLeagueData);

const zebricekMapa = {};
    const mapaPrezdivek = {};

    // 🛡️ SERVEROVÝ DETEKTOR STARTU LIGY PRO OCHRANU BOTOVÝCH AGREGÁTŮ
    const matchesList = Object.values(centralMatches);
    const isLeagueStarted = matchesList.some(z => {
        const startMs = Date.parse(z.datum);
        return (!isNaN(startMs) && startMs <= Date.now()) || z.vysledek_domaci !== undefined || z.apiStatus === "IN_PLAY" || z.apiStatus === "PAUSED" || z.apiStatus === "FINISHED";
    });

    Object.keys(RAM_USERS_PROFILES).forEach(uid => {
        const p = RAM_USERS_PROFILES[uid];
        if (!p.leagues || !p.leagues.includes(leagueName)) return;

        mapaPrezdivek[p.email] = p.nickname;
        mapaPrezdivek[uid] = p.nickname; // Duální mapování pro UID i e-mail
        zebricekMapa[uid] = {
            uid: uid, email: p.email, nickname: p.nickname, celkemBodu: 0, natipovaneVyhodnocene: 0, nenatipovaneVyhodnocene: 0, presneVysledkyCount: 0,
            celkemBoduLive: 0, natipovaneVyhodnoceneLive: 0, nenatipovaneVyhodnoceneLive: 0, presneVysledkyCountLive: 0,
            bodyPoKolech: {}, nejStrelec: '–', vitezMs: '–', nejviceBoduVKole: 0
        };

        const uSouteze = RAM_USERS_TIPS[uid] || {};
        const uSoutezData = uSouteze[ligaKlic] || { tipy: {}, bonusy: {} };

        // 🔒 BEZPEČNOSTNÍ ZÁMEK: Pokud liga ještě neodstartovala, bot do veřejného R2 JSONu hodnoty vůbec nezapíše
        if (isLeagueStarted) {
            zebricekMapa[uid].vitezMs = uSoutezData.bonusy?.vitez || '–';
            zebricekMapa[uid].nejStrelec = uSoutezData.bonusy?.strelec || '–';
        } else {
            zebricekMapa[uid].vitezMs = '🔒 SKRYTO DO STARTU';
            zebricekMapa[uid].nejStrelec = '🔒 SKRYTO DO STARTU';
        }
    });

    if (realLeagueData && (realLeagueData.vitez || realLeagueData.strelec)) {
        const pravidlaLigi = PRAVIDLA_LIG[leagueName] || PRAVIDLA_LIG["DEFAULT"];
        Object.keys(zebricekMapa).forEach(uKey => {
            if (realLeagueData.vitez && zebricekMapa[uKey].vitezMs.toLowerCase() === realLeagueData.vitez.toLowerCase()) {
                zebricekMapa[uKey].celkemBodu += pravidlaLigi.bonusVitez || 0; 
                zebricekMapa[uKey].celkemBoduLive += pravidlaLigi.bonusVitez || 0;
            }
            if (realLeagueData.strelec && zebricekMapa[uKey].nejStrelec.toLowerCase() === realLeagueData.strelec.toLowerCase()) {
                zebricekMapa[uKey].celkemBodu += pravidlaLigi.bonusStrelec || 0; 
                zebricekMapa[uKey].celkemBoduLive += pravidlaLigi.bonusStrelec || 0;
            }
        });
    }

    let aktivniKolo = "1";
    const zapasySerazene = Object.values(centralMatches).sort((a, b) => {
        const dA = new Date(a.datum);
        const dB = new Date(b.datum);
        return dA - dB;
    });
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

    // 🛡️ DETEKTOR DOHRANÝCH A ROZEHRANÝCH KOL
        const kolaZapasyMap = {};
        Object.values(centralMatches).forEach(z => {
            if (z.kolo) {
                const k = String(z.kolo).trim();
                if (!kolaZapasyMap[k]) kolaZapasyMap[k] = [];
                kolaZapasyMap[k].push(z);
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
                // Kolo je rozehrané, pokud už odstartoval aspoň 1 zápas nebo má zapsaný výsledek
                const jeRozehrano = zapasyVKole.some(z => z.vysledek_domaci !== undefined || z.apiStatus === "IN_PLAY" || z.apiStatus === "PAUSED" || (z.datum && new Date(z.datum) <= new Date()));
                if (jeRozehrano) {
                    otevrenaKolaSet.add(klicKola);
                }
            }
        });

        // 🎯 OSOBNÍ REKORD HRÁČE: Výpočet oficiálního maxima i živého rekordu z rozehraných kol
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

        // 👑 KRÁLOVÉ KOL: Titul "Hráč kola" se uděluje VÝHRADNĚ po 100% dohrání všech zápasů kola
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

        // LIVE data i oficiální data sdílí stejný zámek – během rozehraného kola se titul nepředává
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

        // ⚡ REKORDY: Bodové zisky ze VŠECH kol (i rozehraných) soutěží v historickém žebříčku ihned!
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

        // 🔥 PŘEHLED VŠECH OTEVŘENÝCH / ROZEHRANÝCH KOL
        const otevrenaKolaArr = Array.from(otevrenaKolaSet).sort((a, b) => {
            const numA = parseInt(String(a).replace(/[^0-9]/g, '')) || 0;
            const numB = parseInt(String(b).replace(/[^0-9]/g, '')) || 0;
            return numA - numB;
        });

        const otevrenaKolaStatistiky = otevrenaKolaArr.map(klicKola => {
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
                vitezMs: zebricekMapa[uid].vitezMs, nejStrelec: zebricekMapa[uid].nejStrelec,
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
                presneTopMatchesCount: zebricekMapa[uid].presneTopMatchesCountLive || zebricekMapa[uid].presneTopMatchesCount || 0,
                spravneTendenceCount: zebricekMapa[uid].spravneTendenceCountLive || zebricekMapa[uid].spravneTendenceCount || 0,
                vyhranaKolaCount: vyhraVKolePocetLive[zebricekMapa[uid].nickname] || vyhraVKolePocet[zebricekMapa[uid].nickname] || 0,
                perfektniKolaCount: (perfektniKolaSeznam.filter(pk => pk.uid === uid) || []).length,
                nejviceBoduVKole: zebricekMapa[uid].nejviceBoduVKoleLive || zebricekMapa[uid].nejviceBoduVKole || 0, nejviceBoduVKoleNazev: zebricekMapa[uid].nejviceBoduVKoleNazevLive || zebricekMapa[uid].nejviceBoduVKoleNazev || '–',
                vitezMs: zebricekMapa[uid].vitezMs, nejStrelec: zebricekMapa[uid].nejStrelec,
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
            otevrenaKolaSeznam: otevrenaKolaArr,
            aktivniKoloText: aktivniKolo,
            radar: radarStats,
            aktualizovano: timestampNow
        };

        await uploadToR2(leagueName, "leaderboard.json", leaderboardJson);

        // 🏆 SPOUŠTĚČ POHÁROVÉHO ENGINU (FÁZE 3): Výpočet a distribuce cup.json
        await rekonstruujPoharProLigu(leagueName, zebricekPole, centralMatches);

        const pocetZapasu = Object.keys(centralMatches).length;
        const hasMatches = pocetZapasu > 0;

        // 🧠 OBOHACENÍ ROZPISU: Přibalení sezónní formy (V/R/P) a kurzů Bet365 k zápasům
        const zapasyMapaObohacena = {};
        Object.entries(centralMatches).forEach(([mId, z]) => {
            const dTrans = z.domaci;
            const hTrans = z.hoste;
            const matchKey = `${PL_NORM(dTrans)} vs ${PL_NORM(hTrans)}`;
            const matchOdds = RAM_CENTRAL_ODDS[leagueName]?.[matchKey] || null;
            const formaDomaci = spoctiSezonniFormuTymu(dTrans, z.datum, centralMatches);
            const formaHoste = spoctiSezonniFormuTymu(hTrans, z.datum, centralMatches);

            zapasyMapaObohacena[mId] = {
                ...z,
                odds: matchOdds,
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
        await uploadToR2(leagueName, "rozpis.json", rozpisJson);

        if (forceWriteHistory) {
            const uploadPromises = [];

            // 1. 📜 Generování historie tipů každého hráče
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
                uploadPromises.push(uploadToR2(leagueName, `historie_hrace_${uid}.json`, historieJson));
            }

            // 2. 👁️ Generování špehovacích souborů pro všechny odstartované a odehrané zápasy
            Object.keys(centralMatches).forEach(mId => {
                const zapas = centralMatches[mId];
                const jeOdemceny = zapas && (new Date(zapas.datum) <= new Date() || zapas.vysledek_domaci !== undefined || zapas.apiStatus === "IN_PLAY" || zapas.apiStatus === "FINISHED");

                if (jeOdemceny) {
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
                    uploadPromises.push(uploadToR2(leagueName, `spy_zapas_${mId}.json`, spyJson));
                }
            });

            if (uploadPromises.length > 0) {
                await Promise.all(uploadPromises);
            }
        }

        try {
            const pulsRef = db.collection('ligy').doc(leagueName).collection('stav').doc('puls');
            await pulsRef.set({
                verzeRozpisu: admin.firestore.FieldValue.increment(1),
                verzeZebricku: admin.firestore.FieldValue.increment(1),
                aktualizovano: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            console.log(`📡 PULS SYNC [${leagueName}]: Firestore puls aktualizován.`);
        } catch (pulsErr) {
            console.error(`❌ Selhal zápis pulsu pro ${leagueName}:`, pulsErr);
        }

        // 📡 AUTONOMNÍ AKTUALIZACE RADARU (Počítá se přímo z RAM nezávisle na API)
        try {
            const nyniMs = Date.now();
            let ligaBeziLive = false;
            let minBudouciMs = Infinity;
            let pristiZapasIso = null;

            Object.values(centralMatches).forEach(z => {
                const isFinished = z.apiStatus === "FINISHED" || (z.vysledek_domaci !== undefined && z.vysledek_domaci !== null && z.apiStatus !== "IN_PLAY" && z.apiStatus !== "PAUSED");
                const startMs = Date.parse(z.datum);

                if (!isFinished) {
                    if (z.apiStatus === "IN_PLAY" || z.apiStatus === "PAUSED" || (!isNaN(startMs) && startMs <= nyniMs)) {
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

// ⚡ FAST-RETRY POMOCNÍK S 9S TIMEOUT POJISTKOU (MAX 2 POKUSY)
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
            console.log(`⚠️ Live API pokus ${pokus}/${maxPokusu} selhal nebo vypršel timeout 9s (${err.message})...`);
        }
        if (pokus < maxPokusu) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    return null;
}

// =========================================================================
// 🚀 SPOLEHLIVÝ LIVE ENGINE: V2 LIVESCORE API (30S CYKLUS S FAST-RETRY)
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

            // 🔒 LOCK T-0: Zmrazení tipů přesně v čase výkopu
            for (const [mId, stary] of Object.entries(centralZapasy)) {
                const startMs = Date.parse(stary.datum);
                const isPastKickoff = !isNaN(startMs) && (nyniMs >= startMs);
                if (isPastKickoff && !stary.spyUploaded) {
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

        // 📡 Stažení reálných živých výsledků z V2 Livescore přes Fast-Retry
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

        // 🔄 Spárování skóre a aktualizace stavu
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
                } else if (isPastKickoff && stary.apiStatus === "SCHEDULED") {
                    console.log(`🔴 START UTKÁNÍ [${leagueName}]: ${stary.domaci} – ${stary.hoste} odstartoval.`);
                    stary.apiStatus = "IN_PLAY";
                    if (stary.vysledek_domaci === undefined) stary.vysledek_domaci = 0;
                    if (stary.vysledek_hoste === undefined) stary.vysledek_hoste = 0;
                    zmeneneLigySet.add(leagueName);

                    db.collection("ligy").doc(leagueName)
                      .collection("sezony").doc(SEZONA_ID)
                      .collection("zapasy").doc(apiId)
                      .set({ apiStatus: "IN_PLAY", vysledek_domaci: stary.vysledek_domaci, vysledek_hoste: stary.vysledek_hoste }, { merge: true })
                      .catch(e => console.error(`❌ Firestore Sync Error:`, e.message));
                }
            }
        }

        // 🔄 Okamžitá distribuce na R2 a puls pro ligy se změnou
        for (const lName of zmeneneLigySet) {
            await rekonstruujAgregatyProLigu(lName, true);
        }

        if (celkovyObsahujeAktivniZapas) {
            console.log(`[${nyni.toLocaleTimeString('cs-CZ')}] 🚀 STATUS: Zápasy aktivně běží.`);
        }

    } catch (err) {
        console.error(`❌ Kritická chyba v Heartbeat:`, err);
    } finally {
        isHeartbeatRunning = false;
    }
}

// 🕒 ČISTÝ UTC PŘEVODNÍK ČASŮ ZE SPORTOVNÍHO API DO ISO FORMÁTU
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

// 📅 HLOUBKOVÝ KALENDÁŘ: Běží 3x denně (3:00, 9:00, 14:00) – stahuje a mapuje kompletní rozpis všech lig
async function synchronizujRozpisyVsechLig() {
    console.log("=========================================================================");
    console.log("📅 SERVISNÍ KALENDÁŘ: Spouštím hloubkovou synchronizaci zápasů všech lig...");
    console.log("=========================================================================");

    const dbKey = process.env.THESPORTSDB_KEY;
    if (!dbKey) return;

    for (const leagueName of SEZNAM_LIG) {
        const leagueConfig = LIGY_API_MAPA[leagueName] || { id: "WC", provider: "MANUAL" };
        if (leagueConfig.provider === "MANUAL") continue;

        try {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const sezoneYear = String(SEZONA_ID).replace("_", "-");
            const targetApiUrl = `https://www.thesportsdb.com/api/v1/json/${dbKey}/eventsseason.php?id=${leagueConfig.id}&s=${sezoneYear}`;
            const fetchHeaders = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
                "Accept": "application/json, text/plain, */*"
            };

            let response = null;
            for (let pokus = 1; pokus <= 3; pokus++) {
                response = await fetch(targetApiUrl, { headers: fetchHeaders });
                if (response.ok) break;

                if (pokus < 3) {
                    console.log(`⚠️ KALENDÁŘ [${leagueName}]: API vrátilo ${response.status} (pokus ${pokus}/3). Opakuji za 7 s...`);
                    await new Promise(resolve => setTimeout(resolve, 7000));
                }
            }

            if (!response || !response.ok) {
                console.error(`❌ KALENDÁŘ [${leagueName}]: Nepodařilo se stáhnout rozpis ani na 3. pokus (Status: ${response ? response.status : 'Error'}).`);
                continue;
            }

            const apiData = await response.json();
            const rawItems = apiData.events || [];
            console.log(`🔎 KALENDÁŘ [${leagueName}]: Načteno ${rawItems.length} zápasů.`);

            for (const item of rawItems) {
                const apiId = String(item.idEvent);
                const rawDomaci = (item.strHomeTeam || "Neznámý").replace(/ Prague/g, " Praha");
                const rawHoste = (item.strAwayTeam || "Neznámý").replace(/ Prague/g, " Praha");
                const domaci = slovnikTymu[rawDomaci] || rawDomaci;
                const hoste = slovnikTymu[rawHoste] || rawHoste;
                const roundNum = parseInt(item.intRound) || 1;
                const isPlayoff = item.strStage && item.strStage !== "GROUP_STAGE" && item.strStage !== "REGULAR_SEASON";

                const matchIsoDate = parsujZapasDatumDoIso(item);

                let spravneKolo = `${roundNum}. kolo`;
                const stary = RAM_CENTRAL_MATCHES[leagueName]?.[apiId];

                const matchPayload = {
                    domaci: domaci,
                    hoste: hoste,
                    datum: matchIsoDate,
                    kolo: spravneKolo,
                    isPlayoff: isPlayoff || false
                };
                if (stary?.isTopMatch) matchPayload.isTopMatch = true;

                await db.collection("ligy").doc(leagueName).collection("sezony").doc(SEZONA_ID).collection("zapasy").doc(apiId).set(matchPayload, { merge: true });
            }

            await rekonstruujAgregatyProLigu(leagueName, true);
        } catch (e) {
            console.error(`❌ Chyba kalendáře pro ${leagueName}:`, e);
        }
    }
    console.log("✅ Hloubková synchronizace kalendářů dokončena.");
}

// --- 🌐 LIFECYCLE INITIALIZATION BOOTSTRAP ---
async function startEnterpriseApplication() {
    console.log("=========================================================================");
    console.log("👑 CLOUD-NATIVE DAEMON: Inicializuji životní cyklus trvalého mozku...");
    console.log("=========================================================================");

    http.createServer((req, res) => {
        const url = req.url || "/";

        if (url === "/cron" || url.startsWith("/cron")) {
            console.log(`📡 PING PŘIJAT (/cron): Cloudový plánovač udeřil do serveru. Probouzím RAM a odpaluji Heartbeat...`);
            providniApiHeartbeat().catch(err => console.error("❌ Chyba při reaktivním spuštění:", err));
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("OK - Heartbeat spuštěn.");
            return;
        }

        if (url === "/sync-fixtures" || url.startsWith("/sync-fixtures")) {
            console.log(`📅 SERVISNÍ PING (/sync-fixtures): Spouštím hloubkovou kontrolu kalendářů všech lig...`);
            synchronizujRozpisyVsechLig().catch(err => console.error("❌ Chyba při synchronizaci rozpisů:", err));
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("OK - Synchronizace rozpisů zahájena.");
            return;
        }

        if (url === "/sync-odds" || url.startsWith("/sync-odds")) {
            console.log(`📊 SERVISNÍ PING (/sync-odds): Spouštím synchronizaci sázkových kurzů z API-Sports...`);
            synchronizujKurzyVsechLig().then(() => rekonstruujAgregatyVsechny()).catch(err => console.error("❌ Chyba při synchronizaci kurzů:", err));
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("OK - Synchronizace kurzů zahájena.");
            return;
        }

        // Standardní Health Check pro Render (GET /) - do API vůbec nesahá
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("OK - Health Check v pořádku, backend mozek běží.");
    }).listen(PORT, () => {
        console.log(`🌐 HEALTH CHECK PROBE: Síťový port ${PORT} bezpečně otevřen a připraven pro Render.`);
    });

    await hydratujDataZFirestore();
    zapniReaktivniSluchatka();

    // 📊 Úvodní stažení kurzů při startu serveru
    synchronizujKurzyVsechLig().then(() => rekonstruujAgregatyVsechny()).catch(err => console.error("⚠️ Úvodní synchronizace kurzů selhala:", err));

    // ⏱️ AUTONOMNÍ VNITŘNÍ SMYČKA: Bot provádí kontrolu každých 30 sekund (Fast-Retry + 9s timeout)
    console.log("⏱️ AUTONOMNÍ ENGINE: Spouštím bleskovou 30s smyčku pro kontrolu live výsledků...");
    setInterval(() => {
        providniApiHeartbeat().catch(err => console.error("❌ Chyba interního Heartbeatu:", err));
    }, 30000);

    // 🌅 SMYČKA 2: Každé 2 hodiny aktualizace sázkařských kurzů (v čase 06:00 - 22:00)
    setInterval(() => {
        const hodina = new Date().getHours();
        if (hodina >= 6 && hodina <= 22) {
            synchronizujKurzyVsechLig().then(() => rekonstruujAgregatyVsechny()).catch(err => console.error("❌ Chyba periodické synchronizace kurzů:", err));
        }
    }, 2 * 60 * 60 * 1000);
}

startEnterpriseApplication();

// =========================================================================
// 🏆 POHÁROVÝ ENGINE: TIPNI CHANCE CUP & TIPNI PREMIER CUP
// =========================================================================

// 🐍 HADÍ ALGORITMUS PRO ROZDĚLENÍ HRÁČŮ DO SKUPIN (A, B, C, D)
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

// 🥊 POMOCNÝ VÝPOČET TIE-BREAKERU MEZI DVĚMA HRÁČI V PLAY-OFF
function vyhodnotVitezePlayoffDuelu(p1, p2, leagueName = "Chance Liga") {
    if (p1.totalPts > p2.totalPts) return p1.uid;
    if (p2.totalPts > p1.totalPts) return p2.uid;

    if (p1.totalExact > p2.totalExact) return p1.uid;
    if (p2.totalExact > p1.totalExact) return p2.uid;

    if (p1.totalTopExact > p2.totalTopExact) return p1.uid;
    if (p2.totalTopExact > p1.totalTopExact) return p2.uid;

    if (p1.totalTend > p2.totalTend) return p1.uid;
    if (p2.totalTend > p1.totalTend) return p2.uid;

    // Pro Premier League rozhoduje gól útěchy
    if (leagueName === "Premier League") {
        if ((p1.totalConsolations || 0) > (p2.totalConsolations || 0)) return p1.uid;
        if ((p2.totalConsolations || 0) > (p1.totalConsolations || 0)) return p2.uid;
    }

    // 🎯 FINÁLNÍ ROZHODČÍ: Pohárový seed ze základních skupin
    return p1.seed <= p2.seed ? p1.uid : p2.uid;
}

// 🧮 VÝPOČETNÍ MOZEK POHÁRU: PROPOJENÍ SKUPIN A PAVOUKA
async function rekonstruujPoharProLigu(leagueName, zebricekPole, centralMatches) {
    if (leagueName !== "Chance Liga" && leagueName !== "Premier League") return;

    const isPL = leagueName === "Premier League";
    const lockRoundNum = isPL ? 9 : 11;
    const groupStartRound = isPL ? 10 : 12;
    const groupEndRound = isPL ? 19 : 18;

    const ligaKlic = String(leagueName).replace(/ /g, "_");
    const matchesList = Object.values(centralMatches || {});

    // 1. Zjistíme, zda už proběhlo a je dohráno kvalifikační kolo
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

    // 2. Sestavení skupin a výpočet bodů
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

    // 3. Tabulka 2. míst (výhradně pro Chance Ligu)
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

    // 4. Sestavení Play-off
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

// 🧮 VÝPOČETNÍ MODUL PLAY-OFF
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
        // --- 🏴󠁧󠁢󠁥󠁮󠁧󠁿 PREMIER LEAGUE: STEPLADDER PYRAMIDA (20 HRÁČŮ) ---
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

        // 1. Předkolo (21. & 22. kolo: 4. vs 5. místa)
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
        // --- 🇨🇿 CHANCE LIGA: PLAY-OFF (26 HRÁČŮ) ---
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
