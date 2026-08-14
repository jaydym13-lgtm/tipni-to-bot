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
    "Liga národů": { id: "4490", provider: "THESPORTSDB" },
    "Tipsport Extraliga": { id: "4923", provider: "THESPORTSDB" },
    "MS v hokeji": { id: "4859", provider: "THESPORTSDB" }
};

// Seznam lig, které má bot v tomto běhu živě obsluhovat
const SEZNAM_LIG = (process.env.ACTIVE_LEAGUES || "Chance Liga,Premier League,Liga národů,MS ve fotbale,Tipsport Extraliga,MS v hokeji")
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

// 🎛️ GLOBÁLNÍ DYNAMICKÁ KONFIGURACE (Ovládaná ze Super Admin panelu přes Firestore)
const RAM_BOT_CONFIG = {
    active: true,         // Hlavní nouzový vypínač bota
    liveInterval: 3,      // Tvoje zvolené 3 minuty pro live skóre
    waitInterval: 10      // Tvoje zvolených 10 minut pro čekání
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

// --- 📡 DATA PIPELINES (Firestore Real-time Sync) ---
let apiHeartbeatStartedGlobal = false;
const readySignalsGlobal = { users: false, tips: false, matches: false };

function emitReadySignalGlobal(streamName) {
    if (!readySignalsGlobal[streamName]) {
        readySignalsGlobal[streamName] = true;
        console.log(`📡 SIGNÁL POŠŤÁKA: Stream [${streamName}] kompletně natekl ze sítě do RAM paměti.`);
        
        if (readySignalsGlobal.users && readySignalsGlobal.tips && readySignalsGlobal.matches && !apiHeartbeatStartedGlobal) {
            apiHeartbeatStartedGlobal = true;
            console.log("🚀 POŠŤÁK ODPALUJE HLAVNÍ LOOP: Všechna data jsou bezpečně v RAM. Vynucuji úvodní synchronizaci na R2...");
            
            rekonstruujAgregatyVsechny(true).then(() => {
                providniApiHeartbeat();
            }).catch(err => console.error("❌ Selhal úvodní zápis agregátů:", err));
        }
    }
}

function inicializujLiveFirestoreStreams() {
    console.log("👥 Spouštím permanentní RAM synchronizaci uživatelských účtů...");

    db.collection("system").doc("bot_config").onSnapshot(doc => {
        if (doc.exists) {
            const data = doc.data();
            RAM_BOT_CONFIG.active = data.active !== undefined ? data.active : true;
            RAM_BOT_CONFIG.liveInterval = parseInt(data.liveInterval) || 3;
            RAM_BOT_CONFIG.waitInterval = parseInt(data.waitInterval) || 10;
            console.log("🎛️ SYSTEM PANEL CONFIG AKTUALIZOVÁN V RAM:", RAM_BOT_CONFIG);
        }
    }, err => console.error("❌ Chyba streamu ovládání bota:", err));
    
    db.collection("users").onSnapshot(snapshot => {
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
        emitReadySignalGlobal("users");
    }, err => console.error("❌ Chyba streamu uživatelů:", err));

    console.log(`🪐 Ladím rádiový in-memory stream pro všechny sezónní monolity...`);
    db.collectionGroup("sezony").onSnapshot(snapshot => {
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
          planujRekonstrukciAgregatu();
          emitReadySignalGlobal("tips");
      }, (err) => console.error("❌ Kritický výpadek databázového streamu sezón:", err));

    console.log(`📡 Spouštím permanentní synchronizaci zápasů z Firestore pro ligy: ${SEZNAM_LIG.join(', ')}...`);
    
    SEZNAM_LIG.forEach(leagueName => {
        if (!RAM_CENTRAL_MATCHES[leagueName]) RAM_CENTRAL_MATCHES[leagueName] = {};

        db.collection("ligy").doc(leagueName).collection("sezony").doc(SEZONA_ID).collection("zapasy").onSnapshot(snapshot => {
            snapshot.docChanges().forEach(change => {
                const matchId = change.doc.id;
                const data = change.doc.data() || {};
                
                if (change.type === "removed") {
                    delete RAM_CENTRAL_MATCHES[leagueName][matchId];
                } else {
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
            emitReadySignalGlobal("matches");
        }, (err) => console.error(`❌ Chyba streamu zápasů pro ${leagueName}:`, err));
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

async function rekonstruujAgregatyProLigu(leagueName, forceWriteHistory = false) {
    const ligaKlic = String(leagueName).replace(/ /g, "_");
    const centralMatches = RAM_CENTRAL_MATCHES[leagueName] || {};

    if (!readySignalsGlobal.users || !readySignalsGlobal.matches || !readySignalsGlobal.tips) {
        console.log(`⏳ JISTIČ AGREGÁTU [${leagueName}]: Čekám na kompletní načtení Firestore streamů do RAM...`);
        return;
    }
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
        zebricekMapa[p.email] = {
            uid: uid, email: p.email, nickname: p.nickname, celkemBodu: 0, natipovaneVyhodnocene: 0, nenatipovaneVyhodnocene: 0, presneVysledkyCount: 0,
            celkemBoduLive: 0, natipovaneVyhodnoceneLive: 0, nenatipovaneVyhodnoceneLive: 0, presneVysledkyCountLive: 0,
            bodyPoKolech: {}, nejStrelec: '–', vitezMs: '–', nejviceBoduVKole: 0
        };

        const uSouteze = RAM_USERS_TIPS[uid] || {};
        const uSoutezData = uSouteze[ligaKlic] || { tipy: {}, bonusy: {} };

        // 🔒 BEZPEČNOSTNÍ ZÁMEK: Pokud liga ještě neodstartovala, bot do veřejného R2 JSONu hodnoty vůbec nezapíše
        if (isLeagueStarted) {
            zebricekMapa[p.email].vitezMs = uSoutezData.bonusy?.vitez || '–';
            zebricekMapa[p.email].nejStrelec = uSoutezData.bonusy?.strelec || '–';
        } else {
            zebricekMapa[p.email].vitezMs = '🔒 SKRYTO DO STARTU';
            zebricekMapa[p.email].nejStrelec = '🔒 SKRYTO DO STARTU';
        }
    });

    if (realLeagueData && (realLeagueData.vitez || realLeagueData.strelec)) {
        const pravidlaLigi = PRAVIDLA_LIG[leagueName] || PRAVIDLA_LIG["DEFAULT"];
        Object.keys(zebricekMapa).forEach(em => {
            if (realLeagueData.vitez && zebricekMapa[em].vitezMs.toLowerCase() === realLeagueData.vitez.toLowerCase()) {
                zebricekMapa[em].celkemBodu += pravidlaLigi.bonusVitez || 0; 
                zebricekMapa[em].celkemBoduLive += pravidlaLigi.bonusVitez || 0;
            }
            if (realLeagueData.strelec && zebricekMapa[em].nejStrelec.toLowerCase() === realLeagueData.strelec.toLowerCase()) {
                zebricekMapa[em].celkemBodu += pravidlaLigi.bonusStrelec || 0; 
                zebricekMapa[em].celkemBoduLive += pravidlaLigi.bonusStrelec || 0;
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

    Object.keys(zebricekMapa).forEach(email => {
        zebricekMapa[email].bodyPoKolechLive = {};
        zebricekMapa[email].bodyZapasuCelkem = 0;
        zebricekMapa[email].bodyZapasuCelkemLive = 0;
    });

    Object.keys(centralMatches).forEach(matchId => {
        const zapas = centralMatches[matchId];
        const jeVyhodnoceny = (zapas.vysledek_domaci !== undefined && zapas.apiStatus !== "IN_PLAY" && zapas.apiStatus !== "PAUSED");
        const jeBežícíLive = (zapas.apiStatus === "IN_PLAY" || zapas.apiStatus === "PAUSED");
        const jeLiveNeboVyhodnoceny = (zapas.vysledek_domaci !== undefined) || jeBežícíLive;

        const vDomaci = zapas.vysledek_domaci !== undefined && zapas.vysledek_domaci !== null ? zapas.vysledek_domaci : 0;
            const vHoste = zapas.vysledek_hoste !== undefined && zapas.vysledek_hoste !== null ? zapas.vysledek_hoste : 0;

            Object.keys(RAM_USERS_PROFILES).forEach(uid => {
                const em = RAM_USERS_PROFILES[uid].email;
                if (!zebricekMapa[em]) return;

                const uSouteze = RAM_USERS_TIPS[uid] || {};
                const uSoutezData = uSouteze[ligaKlic] || { tipy: {} };
                const uTip = uSoutezData.tipy ? uSoutezData.tipy[matchId] : null;

                if (jeVyhodnoceny) {
                let bodyZapasu = 0;
                if (uTip) {
                    bodyZapasu = vypocitejBodyZapasuLocal(uTip.tip_domaci, uTip.tip_hoste, zapas.vysledek_domaci, zapas.vysledek_hoste, uTip.postup, zapas.postup, zapas.isPlayoff, zapas.isTopMatch, leagueName);
                    zebricekMapa[em].celkemBodu += bodyZapasu; zebricekMapa[em].natipovaneVyhodnocene++;
                    
                    const tD = parseInt(uTip.tip_domaci); const tH = parseInt(uTip.tip_hoste);
                    const rD = parseInt(zapas.vysledek_domaci); const rH = parseInt(zapas.vysledek_hoste);
                    
                    const jePresny = tD === rD && tH === rH && (!zapas.isPlayoff || rD !== rH || uTip.postup === zapas.postup);
                    const jeTendence = (tD > tH && rD > rH) || (tD < tH && rD < rH) || (tD === tH && rD === rH);

                    if (jePresny) {
                        zebricekMapa[em].presneVysledkyCount++;
                        if (zapas.isTopMatch) zebricekMapa[em].presneTopMatchesCount = (zebricekMapa[em].presneTopMatchesCount || 0) + 1;
                    }
                    if (jeTendence) {
                        zebricekMapa[em].spravneTendenceCount = (zebricekMapa[em].spravneTendenceCount || 0) + 1;
                    }
                } else {
                    bodyZapasu = pravidlaLigi.penaltyNenatipovano || 0;
                    zebricekMapa[em].celkemBodu += bodyZapasu;
                    zebricekMapa[em].nenatipovaneVyhodnocene++;
                }
                zebricekMapa[em].bodyZapasuCelkem += bodyZapasu;
                if (zapas.kolo) {
                    const klicKola = String(zapas.kolo).trim();
                    if (zebricekMapa[em].bodyPoKolech[klicKola] === undefined) zebricekMapa[em].bodyPoKolech[klicKola] = 0;
                    zebricekMapa[em].bodyPoKolech[klicKola] += bodyZapasu;
                }
            }

            if (jeLiveNeboVyhodnoceny) {
                let bodyZapasuLive = 0;
                if (uTip) {
                    bodyZapasuLive = vypocitejBodyZapasuLocal(uTip.tip_domaci, uTip.tip_hoste, vDomaci, vHoste, uTip.postup, zapas.postup, zapas.isPlayoff, zapas.isTopMatch, leagueName);
                    zebricekMapa[em].celkemBoduLive += bodyZapasuLive; zebricekMapa[em].natipovaneVyhodnoceneLive++;
                    
                    const tD = parseInt(uTip.tip_domaci); const tH = parseInt(uTip.tip_hoste);
                    const rDLive = parseInt(vDomaci); const rHLive = parseInt(vHoste);

                    const jePresnyLive = tD === rDLive && tH === rHLive && (!zapas.isPlayoff || rDLive !== rHLive || uTip.postup === zapas.postup);
                    const jeTendenceLive = (tD > tH && rDLive > rHLive) || (tD < tH && rDLive < rHLive) || (tD === tH && rDLive === rHLive);

                    if (jePresnyLive) {
                        zebricekMapa[em].presneVysledkyCountLive++;
                        if (zapas.isTopMatch) zebricekMapa[em].presneTopMatchesCountLive = (zebricekMapa[em].presneTopMatchesCountLive || 0) + 1;
                    }
                    if (jeTendenceLive) {
                        zebricekMapa[em].spravneTendenceCountLive = (zebricekMapa[em].spravneTendenceCountLive || 0) + 1;
                    }
                } else {
                    bodyZapasuLive = pravidlaLigi.penaltyNenatipovano || 0;
                    zebricekMapa[em].celkemBoduLive += bodyZapasuLive;
                    zebricekMapa[em].nenatipovaneVyhodnoceneLive++;
                }
                zebricekMapa[em].bodyZapasuCelkemLive += bodyZapasuLive;
                if (zapas.kolo) {
                    const klicKola = String(zapas.kolo).trim();
                    if (zebricekMapa[em].bodyPoKolechLive[klicKola] === undefined) zebricekMapa[em].bodyPoKolechLive[klicKola] = 0;
                    zebricekMapa[em].bodyPoKolechLive[klicKola] += bodyZapasuLive;
                }
            }
        });
    });

    Object.keys(zebricekMapa).forEach(em => {
        let maxPts = 0;
        let maxKolo = '–';
        Object.entries(zebricekMapa[em].bodyPoKolech).forEach(([klicKola, pts]) => {
            if (pts > maxPts) {
                maxPts = pts;
                maxKolo = klicKola;
            }
        });
        zebricekMapa[em].nejviceBoduVKole = maxPts;
        zebricekMapa[em].nejviceBoduVKoleNazev = maxKolo;
    });

    const perfektniKolaSeznam = [];

    if (pravidlaLigi.roundBonus && pravidlaLigi.roundBonus > 0) {
        const kolaZapasyMap = {};
        Object.values(centralMatches).forEach(z => {
            if (z.kolo) {
                const k = String(z.kolo).trim();
                if (!kolaZapasyMap[k]) kolaZapasyMap[k] = [];
                kolaZapasyMap[k].push(z);
            }
        });

        Object.keys(kolaZapasyMap).forEach(klicKola => {
            const zapasyVKole = kolaZapasyMap[klicKola];
            const vsetkoDohrano = zapasyVKole.length > 0 && zapasyVKole.every(z => z.vysledek_domaci !== undefined && z.vysledek_domaci !== null && z.apiStatus !== "IN_PLAY" && z.apiStatus !== "PAUSED");

            if (vsetkoDohrano) {
                Object.keys(RAM_USERS_PROFILES).forEach(uid => {
                    const em = RAM_USERS_PROFILES[uid].email;
                    if (!zebricekMapa[em]) return;

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
                        zebricekMapa[em].celkemBodu += pravidlaLigi.roundBonus;
                        zebricekMapa[em].celkemBoduLive += pravidlaLigi.roundBonus;
                        if (zebricekMapa[em].bodyPoKolech[klicKola] !== undefined) zebricekMapa[em].bodyPoKolech[klicKola] += pravidlaLigi.roundBonus;
                        if (zebricekMapa[em].bodyPoKolechLive[klicKola] !== undefined) zebricekMapa[em].bodyPoKolechLive[klicKola] += pravidlaLigi.roundBonus;
                        
                        perfektniKolaSeznam.push({ nickname: zebricekMapa[em].nickname, round: klicKola });
                    }
                });
            }
        });
    }

    // 👑 KRÁLOVÉ KOL: SPOČÍTÁME VÍTĚZE JEDNOTLIVÝCH DOHRANÝCH KOL
    const vyhraVKolePocet = {};
    const vyhraVKolePocetLive = {};

    const vsechnyKolaKlice = new Set();
    Object.keys(zebricekMapa).forEach(em => {
        Object.keys(zebricekMapa[em].bodyPoKolech || {}).forEach(k => vsechnyKolaKlice.add(k));
    });

    vsechnyKolaKlice.forEach(klicKola => {
        let maxPts = -Infinity;
        Object.keys(zebricekMapa).forEach(em => {
            const pts = zebricekMapa[em].bodyPoKolech?.[klicKola];
            if (pts !== undefined && pts > maxPts && pts > 0) maxPts = pts;
        });
        if (maxPts > 0) {
            Object.keys(zebricekMapa).forEach(em => {
                if (zebricekMapa[em].bodyPoKolech?.[klicKola] === maxPts) {
                    const nick = zebricekMapa[em].nickname;
                    vyhraVKolePocet[nick] = (vyhraVKolePocet[nick] || 0) + 1;
                }
            });
        }

        let maxPtsLive = -Infinity;
        Object.keys(zebricekMapa).forEach(em => {
            const pts = zebricekMapa[em].bodyPoKolechLive?.[klicKola];
            if (pts !== undefined && pts > maxPtsLive && pts > 0) maxPtsLive = pts;
        });
        if (maxPtsLive > 0) {
            Object.keys(zebricekMapa).forEach(em => {
                if (zebricekMapa[em].bodyPoKolechLive?.[klicKola] === maxPtsLive) {
                    const nick = zebricekMapa[em].nickname;
                    vyhraVKolePocetLive[nick] = (vyhraVKolePocetLive[nick] || 0) + 1;
                }
            });
        }
    });

    const vsechnyHraciKola = Object.keys(vyhraVKolePocet).map(nick => ({
        nickname: nick, count: vyhraVKolePocet[nick]
    })).filter(p => p.count > 0);
    const unikatniHraciKolaBadges = [...new Set(vsechnyHraciKola.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
    const top3HraciKola = unikatniHraciKolaBadges.map(count => {
        const nicks = vsechnyHraciKola.filter(p => p.count === count).map(p => p.nickname);
        return { count, names: nicks.join(', ') };
    });

    const vsechnyHraciKolaLive = Object.keys(vyhraVKolePocetLive).map(nick => ({
        nickname: nick, count: vyhraVKolePocetLive[nick]
    })).filter(p => p.count > 0);
    const unikatniHraciKolaBadgesLive = [...new Set(vsechnyHraciKolaLive.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
    const top3HraciKolaLive = unikatniHraciKolaBadgesLive.map(count => {
        const nicks = vsechnyHraciKolaLive.filter(p => p.count === count).map(p => p.nickname);
        return { count, names: nicks.join(', ') };
    });

    const vsechnyPresne = Object.keys(zebricekMapa).map(email => ({
        nickname: zebricekMapa[email].nickname,
        count: zebricekMapa[email].presneVysledkyCount
    })).filter(p => p.count > 0);
    const unikatniPresneBadges = [...new Set(vsechnyPresne.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
    const top3Presne = unikatniPresneBadges.map(count => {
        const nicks = vsechnyPresne.filter(p => p.count === count).map(p => p.nickname);
        return { count, names: nicks.join(', ') };
    });

    // 🔥 NEJVÍC PŘESNÝCH TOP ZÁPASŮ (OFICIÁLNÍ)
    const vsechnyPresneTop = Object.keys(zebricekMapa).map(email => ({
        nickname: zebricekMapa[email].nickname,
        count: zebricekMapa[email].presneTopMatchesCount || 0
    })).filter(p => p.count > 0);
    const unikatniPresneTopBadges = [...new Set(vsechnyPresneTop.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
    const top3PresneTop = unikatniPresneTopBadges.map(count => {
        const nicks = vsechnyPresneTop.filter(p => p.count === count).map(p => p.nickname);
        return { count, names: nicks.join(', ') };
    });

    const vsechnyKolaZisky = [];
    Object.keys(zebricekMapa).forEach(em => {
        const nickname = zebricekMapa[em].nickname;
        Object.keys(zebricekMapa[em].bodyPoKolech).forEach(klicKola => {
            const pts = zebricekMapa[em].bodyPoKolech[klicKola];
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

    const vsechnyPresneLive = Object.keys(zebricekMapa).map(email => ({
        nickname: zebricekMapa[email].nickname,
        count: zebricekMapa[email].presneVysledkyCountLive
    })).filter(p => p.count > 0);
    const unikatniPresneBadgesLive = [...new Set(vsechnyPresneLive.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
    const top3PresneLive = unikatniPresneBadgesLive.map(count => {
        const nicks = vsechnyPresneLive.filter(p => p.count === count).map(p => p.nickname);
        return { count, names: nicks.join(', ') };
    });

    // 🔥 NEJVÍC PŘESNÝCH TOP ZÁPASŮ (LIVE)
    const vsechnyPresneTopLive = Object.keys(zebricekMapa).map(email => ({
        nickname: zebricekMapa[email].nickname,
        count: zebricekMapa[email].presneTopMatchesCountLive || 0
    })).filter(p => p.count > 0);
    const unikatniPresneTopBadgesLive = [...new Set(vsechnyPresneTopLive.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
    const top3PresneTopLive = unikatniPresneTopBadgesLive.map(count => {
        const nicks = vsechnyPresneTopLive.filter(p => p.count === count).map(p => p.nickname);
        return { count, names: nicks.join(', ') };
    });

    // ⚽ NEJVÍC TREFENÝCH SPRÁVNÝCH TENDENCÍ (1, X, 2)
        const vsechnyTendence = Object.keys(zebricekMapa).map(email => ({
            nickname: zebricekMapa[email].nickname,
            count: zebricekMapa[email].spravneTendenceCount || 0
        })).filter(p => p.count > 0);
        const unikatniTendenceBadges = [...new Set(vsechnyTendence.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
        const top3SpravneTendence = unikatniTendenceBadges.map(count => {
            const nicks = vsechnyTendence.filter(p => p.count === count).map(p => p.nickname);
            return { count, names: nicks.join(', ') };
        });

        const vsechnyTendenceLive = Object.keys(zebricekMapa).map(email => ({
            nickname: zebricekMapa[email].nickname,
            count: zebricekMapa[email].spravneTendenceCountLive || 0
        })).filter(p => p.count > 0);
        const unikatniTendenceBadgesLive = [...new Set(vsechnyTendenceLive.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
        const top3SpravneTendenceLive = unikatniTendenceBadgesLive.map(count => {
            const nicks = vsechnyTendenceLive.filter(p => p.count === count).map(p => p.nickname);
            return { count, names: nicks.join(', ') };
        });

        const vsechnyKolaZiskyLive = [];
        Object.keys(zebricekMapa).forEach(em => {
            const nickname = zebricekMapa[em].nickname;
            Object.keys(zebricekMapa[em].bodyPoKolechLive).forEach(klicKola => {
                const pts = zebricekMapa[em].bodyPoKolechLive[klicKola];
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

        const vsechnyAktualniKolo = Object.keys(zebricekMapa).map(em => {
            const stats = zebricekMapa[em];
            const pts = stats.bodyPoKolechLive?.[aktivniKolo] !== undefined ? stats.bodyPoKolechLive[aktivniKolo] : (stats.bodyPoKolech[aktivniKolo] || 0);
            return { nickname: stats.nickname, points: pts };
        }).filter(p => p.points > 0);
        const unikatniAktualniZisky = [...new Set(vsechnyAktualniKolo.map(p => p.points))].sort((a, b) => b - a).slice(0, 3);
        const top3AktualniKolo = unikatniAktualniZisky.map(points => {
            const nicks = vsechnyAktualniKolo.filter(p => p.points === points).map(p => p.nickname);
            return { points, names: nicks.join(', ') };
        });

        const zebricekPole = Object.keys(zebricekMapa).map(em => ({
            uid: zebricekMapa[em].uid, email: em, nickname: zebricekMapa[em].nickname,
            celkemBodu: zebricekMapa[em].celkemBodu, natipovaneVyhodnocene: zebricekMapa[em].natipovaneVyhodnocene,
            nenatipovaneVyhodnocene: zebricekMapa[em].nenatipovaneVyhodnocene, presneVysledkyCount: zebricekMapa[em].presneVysledkyCount,
            presneTopMatchesCount: zebricekMapa[em].presneTopMatchesCount || 0,
            spravneTendenceCount: zebricekMapa[em].spravneTendenceCount || 0,
            vyhranaKolaCount: vyhraVKolePocet[zebricekMapa[em].nickname] || 0,
            perfektniKolaCount: (perfektniKolaSeznam.filter(pk => pk.nickname === zebricekMapa[em].nickname) || []).length,
            nejviceBoduVKole: zebricekMapa[em].nejviceBoduVKole, nejviceBoduVKoleNazev: zebricekMapa[em].nejviceBoduVKoleNazev || '–',
            vitezMs: zebricekMapa[em].vitezMs, nejStrelec: zebricekMapa[em].nejStrelec,
            bodyKoloAktualni: zebricekMapa[em].bodyPoKolech[aktivniKolo] || 0,
            efektivitaProcento: maxMoznychBoduZapasu > 0 ? (zebricekMapa[em].bodyZapasuCelkem / maxMoznychBoduZapasu) * 100 : 0
        })).sort((a, b) => {
            if (b.celkemBodu !== a.celkemBodu) return b.celkemBodu - a.celkemBodu;
            return b.presneVysledkyCount - a.presneVysledkyCount;
        });

        const zebricekLivePole = Object.keys(zebricekMapa).map(em => ({
            uid: zebricekMapa[em].uid, email: em, nickname: zebricekMapa[em].nickname,
            celkemBodu: zebricekMapa[em].celkemBoduLive, natipovaneVyhodnocene: zebricekMapa[em].natipovaneVyhodnoceneLive,
            nenatipovaneVyhodnocene: zebricekMapa[em].nenatipovaneVyhodnoceneLive, presneVysledkyCount: zebricekMapa[em].presneVysledkyCountLive,
            presneTopMatchesCount: zebricekMapa[em].presneTopMatchesCountLive || zebricekMapa[em].presneTopMatchesCount || 0,
            spravneTendenceCount: zebricekMapa[em].spravneTendenceCountLive || zebricekMapa[em].spravneTendenceCount || 0,
            vyhranaKolaCount: vyhraVKolePocetLive[zebricekMapa[em].nickname] || vyhraVKolePocet[zebricekMapa[em].nickname] || 0,
            perfektniKolaCount: (perfektniKolaSeznam.filter(pk => pk.nickname === zebricekMapa[em].nickname) || []).length,
            nejviceBoduVKole: zebricekMapa[em].nejviceBoduVKole, nejviceBoduVKoleNazev: zebricekMapa[em].nejviceBoduVKoleNazev || '–',
            vitezMs: zebricekMapa[em].vitezMs, nejStrelec: zebricekMapa[em].nejStrelec,
            bodyKoloAktualni: zebricekMapa[em].bodyPoKolechLive?.[aktivniKolo] !== undefined ? zebricekMapa[em].bodyPoKolechLive[aktivniKolo] : (zebricekMapa[em].bodyPoKolech[aktivniKolo] || 0),
            efektivitaProcento: maxMoznychBoduZapasu > 0 ? (zebricekMapa[em].bodyZapasuCelkemLive / maxMoznychBoduZapasu) * 100 : 0
        })).sort((a, b) => {
            if (b.celkemBodu !== a.celkemBodu) return b.celkemBodu - a.celkemBodu;
            return b.presneVysledkyCount - a.presneVysledkyCount;
        });

        zebricekLivePole.forEach(p => {
            const em = p.email;
            if (zebricekMapa[em] && zebricekMapa[em].bodyPoKolechLive) {
                p.bodyKoloAktualni = zebricekMapa[em].bodyPoKolechLive[aktivniKolo] !== undefined ? zebricekMapa[em].bodyPoKolechLive[aktivniKolo] : (zebricekMapa[em].bodyPoKolech[aktivniKolo] || 0);
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
            top3AktualniKolo: top3AktualniKolo,
            aktivniKoloText: aktivniKolo,
            aktualizovano: timestampNow
        };

        await uploadToR2(leagueName, "leaderboard.json", leaderboardJson);

        // 🧮 VÝPOČETNÍ MOZEK POHÁRU: SKUPINY (12.–18. KOLO) + SOUBOJ 2. MÍST + PLAY-OFF (19.–27. KOLO)
async function rekonstruujPoharProLigu(leagueName, zebricekPole, centralMatches) {
    if (leagueName !== "Chance Liga") return;

    const ligaKlic = String(leagueName).replace(/ /g, "_");
    const matchesList = Object.values(centralMatches || {});

    // 1. Zjistíme, zda už proběhlo a je dohráno kompletní 11. kolo (Zámek Kvalifikace)
    const r11Matches = matchesList.filter(z => {
        const k = String(z.kolo || "").trim().toLowerCase();
        return k === "11. kolo" || k === "11";
    });
    const r11Finished = r11Matches.length > 0 && r11Matches.every(z => 
        z.vysledek_domaci !== undefined && z.vysledek_domaci !== null && z.apiStatus !== "IN_PLAY" && z.apiStatus !== "PAUSED"
    );

    // Načteme trvalý stav zámku z dokumentu ligy
    const leagueDocSnap = await db.collection("ligy").doc(leagueName).get().catch(() => null);
    const lData = leagueDocSnap && leagueDocSnap.exists ? leagueDocSnap.data() : {};
    let lockedData = lData.cupLock || null;

    // 🔒 AUTOMATICKÝ ZÁMEK PO 11. KOLE
    if (r11Finished && !lockedData && zebricekPole.length > 0) {
        console.log(`🔒 CUP LOCK TRIGGER [${leagueName}]: 11. kolo oficiálně dohráno! Zamykám složení skupin Poháru.`);
        const lockedDraft = vypocitejHadíRozdeleni(zebricekPole);
        lockedData = {
            status: "GROUPS_LOCKED",
            lockedAtRound: 11,
            lockedAt: new Date().toISOString(),
            initialGroups: lockedDraft
        };
        await db.collection("ligy").doc(leagueName).set({ cupLock: lockedData }, { merge: true }).catch(e => console.error("❌ Chyba zápisu cup_lock:", e));
    }

    const isGroupsLocked = Boolean(lockedData && lockedData.initialGroups);
    const status = isGroupsLocked ? "GROUPS_LOCKED" : "PREVIEW";

    // 2. Sestavení skupin a výpočet bodů (12. až 18. kolo)
    const groupsDraft = isGroupsLocked ? lockedData.initialGroups : vypocitejHadíRozdeleni(zebricekPole);
    const finalGroups = { A: [], B: [], C: [], D: [] };

    const groupStageMatches = matchesList.filter(z => {
        const kNum = parseInt(String(z.kolo || "").replace(/[^0-9]/g, ""));
        return kNum >= 12 && kNum <= 18;
    });

    for (const grpKey of ["A", "B", "C", "D"]) {
        const members = groupsDraft[grpKey] || [];
        
        finalGroups[grpKey] = members.map(m => {
            let pts = 0;
            let exact = 0;
            let topExact = 0;
            let tend = 0;

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
                tend: tend
            };
        });

        // 5-stupňový tie-break ve skupině
        finalGroups[grpKey].sort((a, b) => {
            if (isGroupsLocked) {
                if (b.pts !== a.pts) return b.pts - a.pts;
                if (b.exact !== a.exact) return b.exact - a.exact;
                if (b.topExact !== a.topExact) return b.topExact - a.topExact;
                if (b.tend !== a.tend) return b.tend - a.tend;
                return a.seed - b.seed; // Kvalifikační seed z 11. kola
            }
            return a.seed - b.seed;
        });
    }

    // 3. Sestavení Mini-tabulky 2. míst (Boj o přímý postup do TOP 6)
    let secondPlacesRank = [];
    if (isGroupsLocked) {
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

    // 4. Sestavení Play-off (po odehrání podzimních skupin – 18. kolo)
    const playoffData = sestavPlayoffPavouka(leagueName, finalGroups, secondPlacesRank, matchesList);

    const cupJson = {
        leagueName: leagueName,
        status: playoffData ? "PLAYOFF" : status,
        lockedAtRound: isGroupsLocked ? 11 : null,
        groups: finalGroups,
        secondPlacesRank: secondPlacesRank,
        playoff: playoffData,
        aktualizovano: new Date().toISOString()
    };

    await uploadToR2(leagueName, "cup.json", cupJson);
}

// 🥊 POMOCNÝ VÝPOČET TIE-BREAKERU MEZI DVĚMA HRÁČI V PLAY-OFF
function vyhodnotVitezePlayoffDuelu(p1, p2) {
    if (p1.totalPts > p2.totalPts) return p1.uid;
    if (p2.totalPts > p1.totalPts) return p2.uid;

    if (p1.totalExact > p2.totalExact) return p1.uid;
    if (p2.totalExact > p1.totalExact) return p2.uid;

    if (p1.totalTopExact > p2.totalTopExact) return p1.uid;
    if (p2.totalTopExact > p1.totalTopExact) return p2.uid;

    if (p1.totalTend > p2.totalTend) return p1.uid;
    if (p2.totalTend > p1.totalTend) return p2.uid;

    return p1.seed <= p2.seed ? p1.uid : p2.uid; // Generální Play-off seed po 18. kole
}

// 🧮 VÝPOČETNÍ MODUL PLAY-OFF PRO KOLA 19 AŽ 27
function sestavPlayoffPavouka(leagueName, finalGroups, secondPlacesRank, matchesList) {
    const r18Matches = matchesList.filter(z => parseInt(String(z.kolo || '').replace(/[^0-9]/g, '')) === 18);
    const r18Finished = r18Matches.length > 0 && r18Matches.every(z => z.vysledek_domaci !== undefined && z.apiStatus !== 'IN_PLAY');

    if (!r18Finished) return null;

    const top4Winners = ['A', 'B', 'C', 'D'].map(k => finalGroups[k]?.[0]).filter(Boolean);
    top4Winners.sort((a, b) => b.pts - a.pts || b.exact - a.exact || a.seed - b.seed);

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
    restOfPlayers.sort((a, b) => b.pts - a.pts || b.exact - a.exact || a.seed - b.seed);

    const fullSeeding = [
        ...top4Winners.map((p, i) => ({ ...p, generalSeed: i + 1 })),
        ...top2Seconds.map((p, i) => ({ ...p, generalSeed: i + 5 })),
        ...restOfPlayers.map((p, i) => ({ ...p, generalSeed: i + 7 }))
    ];

    const getPlayerRoundStats = (uid, roundNum) => {
        const uSouteze = RAM_USERS_TIPS[uid] || {};
        const ligaKlic = String(leagueName).replace(/ /g, '_');
        const uTips = (uSouteze[ligaKlic] && uSouteze[ligaKlic].tipy) ? uSouteze[ligaKlic].tipy : {};

        const roundMatches = matchesList.filter(z => parseInt(String(z.kolo || '').replace(/[^0-9]/g, '')) === roundNum);
        let pts = 0, exact = 0, topExact = 0, tend = 0;
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
                }
            }
        });

        return { pts, exact, topExact, tend, isStarted };
    };

    // 10 duelů jarního Předkola (19. & 20. kolo)
    const preRoundDuels = [];
    for (let i = 0; i < 10; i++) {
        const p1Seed = fullSeeding[6 + i];
        const p2Seed = fullSeeding[25 - i];

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
        const winnerUid = isFinished ? vyhodnotVitezePlayoffDuelu(p1Obj, p2Obj) : null;

        preRoundDuels.push({
            duelId: `PR_${i + 1}`,
            title: `Předkolo ${i + 1}`,
            statusText: isFinished ? 'DOHRÁNO ✓' : (p1L1.isStarted ? 'ODVETA ⏳' : 'ČEKÁ NA VÝKOP'),
            p1: p1Obj,
            p2: p2Obj,
            winnerUid: winnerUid
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
