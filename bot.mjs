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
                    
                    const jePresny = parseInt(uTip.tip_domaci) === parseInt(zapas.vysledek_domaci) &&
                                     parseInt(uTip.tip_hoste) === parseInt(zapas.vysledek_hoste) &&
                                     (!zapas.isPlayoff || zapas.vysledek_domaci !== zapas.vysledek_hoste || uTip.postup === zapas.postup);
                    if (jePresny) {
                        zebricekMapa[em].presneVysledkyCount++;
                        if (zapas.isTopMatch) {
                            zebricekMapa[em].presneTopMatchesCount = (zebricekMapa[em].presneTopMatchesCount || 0) + 1;
                        }
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
                    
                    const jePresnyLive = parseInt(uTip.tip_domaci) === parseInt(vDomaci) &&
                                         parseInt(uTip.tip_hoste) === parseInt(vHoste) &&
                                         (!zapas.isPlayoff || vDomaci !== vHoste || uTip.postup === zapas.postup);
                    if (jePresnyLive) {
                        zebricekMapa[em].presneVysledkyCountLive++;
                        if (zapas.isTopMatch) {
                            zebricekMapa[em].presneTopMatchesCountLive = (zebricekMapa[em].presneTopMatchesCountLive || 0) + 1;
                        }
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
                    }
                });
            }
        });
    }

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
        top3Kola: top3Kola,
        top3PresneLive: top3PresneLive,
        top3PresneTopLive: top3PresneTopLive,
        top3KolaLive: top3KolaLive,
        top3AktualniKolo: top3AktualniKolo,
        aktivniKoloText: aktivniKolo,
        aktualizovano: timestampNow
    };

    await uploadToR2(leagueName, "leaderboard.json", leaderboardJson);

    const pocetZapasu = Object.keys(centralMatches).length;
    const hasMatches = pocetZapasu > 0;

    const rozpisJson = { 
        zapasyMapa: centralMatches, 
        hasMatches: hasMatches, 
        aktualizovano: timestampNow 
    };
    await uploadToR2(leagueName, "rozpis.json", rozpisJson);

    if (forceWriteHistory) {
        const historiePromises = [];

        for (const uid of Object.keys(RAM_USERS_PROFILES)) {
            const uSouteze = RAM_USERS_TIPS[uid] || {};
            const hracovyTipyVsechny = (uSouteze[ligaKlic] && uSouteze[ligaKlic].tipy) ? uSouteze[ligaKlic].tipy : {};
            const hracovyTipyOdemcene = {};

            Object.keys(hracovyTipyVsechny).forEach(mId => {
                const zapas = centralMatches[mId];
                if (zapas && new Date(zapas.datum) <= new Date()) {
                    hracovyTipyOdemcene[mId] = hracovyTipyVsechny[mId];
                }
            });

            const historieJson = { mapaTipu: hracovyTipyOdemcene, vytvoreno: timestampNow };
            const uploadPromise = uploadToR2(leagueName, `historie_hrace_${uid}.json`, historieJson);
            historiePromises.push(uploadPromise);
        }

        if (historiePromises.length > 0) {
            await Promise.all(historiePromises);
        }
    }

    if (forceWriteHistory) {
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
    }
}

let isHeartbeatRunning = false;

async function providniApiHeartbeat() {
    if (isHeartbeatRunning) {
        console.log("⏳ HEARTBEAT ALREADY RUNNING: Přeskakuji paralelní požadavek...");
        return;
    }
    isHeartbeatRunning = true;

    try {
        console.log(`[${new Date().toLocaleTimeString()}] ⏱️ Heartbeat kontrola sportovního API pro ligy: ${SEZNAM_LIG.join(', ')}...`);
        
        if (!RAM_BOT_CONFIG.active) {
            console.log("⛔ BOT MANUÁLNĚ VYPNUT: Ovládací panel hlásí force_stop. Spím a nezatěžuji API...");
            setTimeout(providniApiHeartbeat, RAM_BOT_CONFIG.waitInterval * 60 * 1000);
            return;
        }

    const dbKey = process.env.THESPORTSDB_KEY;

    let celkovyDosloKStavoveZmene = false;
    let celkovyObsahujeAktivniZapas = false;
    let minRozdilDoZapasu = Infinity;
    let pristiZapasIso = null;

    // 🧠 Výpočet nejbližšího budoucího zápasu přímo z RAM (nezávisle na API)
    for (const lName of SEZNAM_LIG) {
        const cZapasy = Object.values(RAM_CENTRAL_MATCHES[lName] || {});
        for (const z of cZapasy) {
            if (z.vysledek_domaci !== undefined || z.apiStatus === "FINISHED") continue;
            const startMs = Date.parse(z.datum);
            if (!isNaN(startMs)) {
                const rozdilMin = (startMs - Date.now()) / (1000 * 60);
                if (rozdilMin > 0 && rozdilMin < minRozdilDoZapasu) {
                    minRozdilDoZapasu = rozdilMin;
                    pristiZapasIso = z.datum;
                }
            }
        }
    }

    for (const leagueName of SEZNAM_LIG) {
        const leagueConfig = LIGY_API_MAPA[leagueName] || { id: "WC", provider: "MANUAL" };
        const provider = leagueConfig.provider;
        const leagueApiId = leagueConfig.id;

        if (provider === "MANUAL") {
            console.log(`ℹ️ Liga [${leagueName}] běží v čistém Firestore režimu (MANUAL).`);
            continue;
        }

        const centralneZapasyLigy = Object.values(RAM_CENTRAL_MATCHES[leagueName] || {});
        const maAktivniZapasVRam = centralneZapasyLigy.some(z => z.apiStatus === "IN_PLAY" || z.apiStatus === "PAUSED");
            const nyniMs = Date.now();

            // 🎯 OCHRANA PŘED SLEPOU SKVRNOU: Kontrolujeme i neukončené zápasy z posledních 4 hodin (-240 min)!
            const maNeukoncenyZapasBlizko = centralneZapasyLigy.some(z => {
                if (z.apiStatus === "FINISHED") return false;
                const startMs = Date.parse(z.datum);
                if (isNaN(startMs)) return false;
                const rozdilMinut = (startMs - nyniMs) / (1000 * 60);
                return rozdilMinut >= -240 && rozdilMinut <= 120;
            });

            const maPrazdnouRam = centralneZapasyLigy.length === 0;

            if (!maPrazdnouRam && !maAktivniZapasVRam && !maNeukoncenyZapasBlizko) {
                console.log(`💤 SMART SCHEDULER [${leagueName}]: Žádný aktivní ani blízký zápas. Šetřím API kredity.`);
                continue;
            }

        try {
            let matches = [];

            if (provider === "THESPORTSDB") {
                if (!dbKey) {
                    console.log(`⚠️ Chybí THESPORTSDB_KEY pro [${leagueName}]. Přeskakuji...`);
                    continue;
                }

                await new Promise(resolve => setTimeout(resolve, 1000));

                const sezoneYear = String(SEZONA_ID).replace("_", "-");

                const response = await fetch(`https://www.thesportsdb.com/api/v1/json/${dbKey}/eventsseason.php?id=${leagueApiId}&s=${sezoneYear}`);

                if (!response.ok) throw new Error(`TheSportsDB error (${leagueName}): ${response.status}`);
                const apiData = await response.json();
                const rawItems = apiData.events || [];

                console.log(`🔎 THESPORTSDB ENGINE [${leagueName}]: Načteno ${rawItems.length} reálných zápasů.`);

                matches = rawItems.map(item => {
                    const statusRaw = item.strStatus || "";
                    const isFinished = statusRaw === "Match Finished" || statusRaw === "FT";
                    const isLive = statusRaw === "In Progress" || statusRaw === "1H" || statusRaw === "2H" || statusRaw === "HT";
                    const statusStr = isFinished ? "FINISHED" : (isLive ? "IN_PLAY" : "SCHEDULED");

                    const hasValidScore = item.intHomeScore !== null && item.intHomeScore !== undefined && item.intAwayScore !== null && item.intAwayScore !== undefined;
                    const homeScore = (isFinished || isLive) && hasValidScore ? parseInt(item.intHomeScore) : undefined;
                    const awayScore = (isFinished || isLive) && hasValidScore ? parseInt(item.intAwayScore) : undefined;

                    const rawHomeClean = (item.strHomeTeam || "Neznámý").replace(/ Prague/g, " Praha");
                    const rawAwayClean = (item.strAwayTeam || "Neznámý").replace(/ Prague/g, " Praha");
                    const roundNum = parseInt(item.intRound) || 1;

                    let matchIsoDate = new Date().toISOString();
                    let rawStr = item.strTimestamp || (item.dateEvent ? `${item.dateEvent}T${item.strTime || "00:00:00"}` : null);
                    if (rawStr) {
                        rawStr = rawStr.replace(" ", "T");
                        if (!rawStr.endsWith("Z") && !rawStr.includes("+") && !rawStr.includes("-")) {
                            rawStr += "Z";
                        }
                        const parsedDate = new Date(rawStr);
                        if (!isNaN(parsedDate.getTime())) {
                            // 🤖 Plně automatický výpočet posunu pro Europe/Prague (Léto: +2h, Zima: +1h)
                            const czTime = new Date(parsedDate.toLocaleString("en-US", { timeZone: "Europe/Prague" }));
                            const utcTime = new Date(parsedDate.toLocaleString("en-US", { timeZone: "UTC" }));
                            const diffHours = Math.round((czTime - utcTime) / (1000 * 60 * 60));

                            parsedDate.setHours(parsedDate.getHours() + diffHours);
                            matchIsoDate = parsedDate.toISOString();
                        }
                    }

                    return {
                        id: String(item.idEvent),
                        status: statusStr,
                        utcDate: matchIsoDate,
                        homeTeam: { name: slovnikTymu[rawHomeClean] || rawHomeClean },
                        awayTeam: { name: slovnikTymu[rawAwayClean] || rawAwayClean },
                        stage: "REGULAR_SEASON",
                        matchday: roundNum,
                        score: {
                            fullTime: { home: homeScore, away: awayScore },
                            winner: (homeScore > awayScore) ? "HOME_TEAM" : ((awayScore > homeScore) ? "AWAY_TEAM" : null)
                        }
                    };
                });
            }

            const nyniMilisekundy = Date.now();
            const nyni = new Date();

            for (const match of matches) {
                const apiId = String(match.id);
                const status = match.status;
                const startZapasuMilisekundy = Date.parse(match.utcDate);
                const rozdilMinut = (startZapasuMilisekundy - nyniMilisekundy) / (1000 * 60);

                const uzSeHrajePodleAPI = status === "IN_PLAY" || status === "PAUSED" || status === "LIVE";
                const matchStarted = uzSeHrajePodleAPI || (nyniMilisekundy >= startZapasuMilisekundy);

                if (status !== "FINISHED" && rozdilMinut <= 0) {
                    celkovyObsahujeAktivniZapas = true;
                }

                if (rozdilMinut > 0 && rozdilMinut < minRozdilDoZapasu) {
                    minRozdilDoZapasu = rozdilMinut;
                    pristiZapasIso = match.utcDate;
                }

                const rawDomaci = match.homeTeam?.name || "Neznámý";
                const rawHoste = match.awayTeam?.name || "Neznámý";
                const domaci = slovnikTymu[rawDomaci] || rawDomaci;
                const hoste = slovnikTymu[rawHoste] || rawHoste;
                const isPlayoff = match.stage !== "GROUP_STAGE" && match.stage !== "REGULAR_SEASON";

                let golyDomaci = undefined; let golyHoste = undefined; let postupVal = "";
                const jeZapasAktivni = status === "FINISHED" || status === "IN_PLAY" || status === "PAUSED";
                
                if (jeZapasAktivni && match.score) {
                    const fTime = match.score.fullTime;
                    const eTime = match.score.extraTime || { home: 0, away: 0 };
                    const pTime = match.score.penalties || { home: 0, away: 0 };

                    if (fTime && fTime.home !== null && fTime.home !== undefined) {
                        let extraHome = (eTime.home !== null && eTime.home !== undefined) ? parseInt(eTime.home) : 0;
                        let extraAway = (eTime.away !== null && eTime.away !== undefined) ? parseInt(eTime.away) : 0;
                        let penHome = (pTime.home !== null && pTime.home !== undefined) ? parseInt(pTime.home) : 0;
                        let penAway = (pTime.away !== null && pTime.away !== undefined) ? parseInt(pTime.away) : 0;

                        if (status === "FINISHED" && match.score.duration === "EXTRA_TIME") {
                            golyDomaci = parseInt(fTime.home) - extraHome;
                            golyHoste = parseInt(fTime.away) - extraAway;
                        } else if (status === "FINISHED" && match.score.duration === "PENALTY_SHOOTOUT") {
                            golyDomaci = parseInt(fTime.home) - extraHome - penHome;
                            golyHoste = parseInt(fTime.away) - extraAway - penAway;
                        } else {
                            golyDomaci = parseInt(fTime.home);
                            golyHoste = parseInt(fTime.away);
                        }
                    }

                    if (isPlayoff && match.score.winner) {
                        if (match.score.winner === "HOME_TEAM") postupVal = "domaci";
                        if (match.score.winner === "AWAY_TEAM") postupVal = "hoste";
                    }
                }

                if (status === "IN_PLAY" || status === "PAUSED") {
                    celkovyObsahujeAktivniZapas = true;
                }

                const stary = RAM_CENTRAL_MATCHES[leagueName] ? RAM_CENTRAL_MATCHES[leagueName][apiId] : null;
                let spyJizOdeslano = stary?.spyUploaded || false;

                if (status !== "FINISHED" && matchStarted && !spyJizOdeslano) {
                    console.log(`🔒 LOCK T-0 [${leagueName}]: Výkop zápasu ${domaci} – ${hoste}. Zmrazuji tipy!`);
                    
                    const tipyProZapasPole = [];
                    Object.keys(RAM_USERS_PROFILES).forEach(uid => {
                        const p = RAM_USERS_PROFILES[uid];
                        if (!p.leagues || !p.leagues.includes(leagueName)) return;
                        const uSouteze = RAM_USERS_TIPS[uid] || {};
                        const ligaKlic = String(leagueName).replace(/ /g, "_");
                        const uTips = (uSouteze[ligaKlic] && uSouteze[ligaKlic].tipy) ? uSouteze[ligaKlic].tipy : {};
                        const uTip = uTips[apiId];
                        if (uTip && uTip.tip_domaci !== undefined) {
                            tipyProZapasPole.push({
                                userEmail: p.email,
                                nickname: p.nickname,
                                tip_domaci: parseInt(uTip.tip_domaci),
                                tip_hoste: parseInt(uTip.tip_hoste),
                                postup: uTip.postup || ''
                            });
                        }
                    });

                    await uploadToR2(leagueName, `spy_zapas_${apiId}.json`, { tipy: tipyProZapasPole, aktualizovano: nyni.toISOString() });
                    spyJizOdeslano = true;
                    celkovyDosloKStavoveZmene = true;
                }

                if (!stary || stary.apiStatus !== status || stary.vysledek_domaci !== golyDomaci || stary.vysledek_hoste !== golyHoste || stary.postup !== postupVal) {
                    celkovyDosloKStavoveZmene = true;
                }

                const stage = match.stage || "";
                let spravneKoloTurnaje = "Šampionát";

                if (isPlayoff) {
                    if (stage === "QUARTER_FINALS") spravneKoloTurnaje = "Čtvrtfinále";
                    else if (stage === "SEMI_FINALS") spravneKoloTurnaje = "Semifinále";
                    else if (stage === "THIRD_PLACE") spravneKoloTurnaje = "Zápas o 3. místo";
                    else if (stage === "FINAL") spravneKoloTurnaje = "Finále";
                    else spravneKoloTurnaje = "Play-off";
                } else if (match.matchday && parseInt(match.matchday) > 0) {
                    spravneKoloTurnaje = `${parseInt(match.matchday)}. kolo`;
                }
                const finalDomaci = (!stary || stary.domaci === "Neznámý") ? domaci : stary.domaci;
                const finalHoste = (!stary || stary.hoste === "Neznámý") ? hoste : stary.hoste;

                const detekovanNovyRozlosovanyTym = stary && (stary.domaci === "Neznámý" && domaci !== "Neznámý");
                const jeUkoncenBezVysledkuVDB = status === "FINISHED" && golyDomaci !== undefined && golyHoste !== undefined && (!stary || stary.vysledek_domaci === undefined);
                const potrebujeOpravitKoloVDB = stary && (stary.kolo !== spravneKoloTurnaje);

                const jeNovyZapasVDB = !stary;

                // 🛡️ OCHRANA PROTI ZASEKNUTÍ V IN_PLAY: Hlídáme změnu stavu API i skóre
                const zmenilSeApiStatus = stary && (stary.apiStatus !== status);
                const zmeniloSeSkore = stary && (stary.vysledek_domaci !== golyDomaci || stary.vysledek_hoste !== golyHoste);

                const potrebujeOpravitNazevTymu = stary && (stary.domaci !== domaci || stary.hoste !== hoste);
                const potrebujeOpravitDatumVDB = stary && (stary.datum !== match.utcDate);

                if (jeNovyZapasVDB || zmenilSeApiStatus || zmeniloSeSkore || detekovanNovyRozlosovanyTym || jeUkoncenBezVysledkuVDB || potrebujeOpravitKoloVDB || potrebujeOpravitNazevTymu || potrebujeOpravitDatumVDB) {
                    console.log(`💾 AUTO-SYNC FIREBASE [${leagueName}]: ${finalDomaci} - ${finalHoste} (${spravneKoloTurnaje})`);
                    const syncPayload = {
                        domaci: domaci,
                        hoste: hoste,
                        apiStatus: status,
                        kolo: spravneKoloTurnaje,
                        isPlayoff: isPlayoff,
                        datum: match.utcDate
                    };
                    if (stary?.isTopMatch) syncPayload.isTopMatch = true;
                    if (golyDomaci !== undefined) syncPayload.vysledek_domaci = golyDomaci;
                    if (golyHoste !== undefined) syncPayload.vysledek_hoste = golyHoste;
                    if (postupVal) syncPayload.postup = postupVal;

                    db.collection("ligy").doc(leagueName).collection("sezony").doc(SEZONA_ID).collection("zapasy").doc(apiId).set(syncPayload, { merge: true })
                        .catch(e => console.error(`❌ Chyba sync Firebase [${leagueName}]:`, e));
                }

                if (!RAM_CENTRAL_MATCHES[leagueName]) RAM_CENTRAL_MATCHES[leagueName] = {};
                RAM_CENTRAL_MATCHES[leagueName][apiId] = {
                    domaci: finalDomaci,
                    hoste: finalHoste,
                    datum: match.utcDate,
                    isPlayoff: stary?.isPlayoff !== undefined ? stary.isPlayoff : isPlayoff,
                    isTopMatch: stary?.isTopMatch || false,
                    kolo: spravneKoloTurnaje,
                    stage: match.stage || stary?.stage || "",
                    vysledek_domaci: golyDomaci !== undefined ? golyDomaci : stary?.vysledek_domaci,
                    vysledek_hoste: golyHoste !== undefined ? golyHoste : stary?.vysledek_hoste,
                    apiStatus: status,
                    postup: postupVal || stary?.postup || "",
                    spyUploaded: spyJizOdeslano
                };
            }

            try {
                await db.collection("ligy").doc(leagueName).collection("stav").doc("radar").set({
                    beziLive: celkovyObsahujeAktivniZapas,
                    pristiZapasUtc: pristiZapasIso || null,
                    aktualizovano: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            } catch (radarErr) {
                console.error(`❌ Selhal radar pro ${leagueName}:`, radarErr);
            }

        } catch (err) {
            console.error(`❌ Chyba v heartbeat smyčce pro ${leagueName}:`, err);
        }
    }

    // 🚀 PERMANENTNÍ SYNC NA R2 PRO VŠECHNY LIGY: Zaručí existenci platných 200 OK JSONů na R2 (zlikviduje 404 v konzoli)
    if (celkovyDosloKStavoveZmene) {
        await rekonstruujAgregatyVsechny(true);
    }

    const jeZapasV_OkneBojovehoRezimu = minRozdilDoZapasu <= 6;
    if (celkovyObsahujeAktivniZapas || jeZapasV_OkneBojovehoRezimu) {
        console.log(`🚀 STATUS: Zápasy aktivně běží nebo se blíží výkop.`);
    } else {
        console.log(`💤 STATUS: Klid zbraní. Nejbližší zápas je za ${Math.round(minRozdilDoZapasu)} min.`);
    }
} catch (err) {
        console.error(`❌ Chyba v heartbeat smyčce:`, err);
    } finally {
        isHeartbeatRunning = false;
    }
}

// --- 🌐 LIFECYCLE INITIALIZATION BOOTSTRAP ---
async function startEnterpriseApplication() {

    console.log("=========================================================================");
    console.log("👑 CLOUD-NATIVE DAEMON: Inicializuji životní cyklus trvalého mozku...");
    console.log("=========================================================================");

    http.createServer((req, res) => {
        console.log(`📡 PING PŘIJAT: Cloudový plánovač udeřil do serveru. Probouzím RAM a odpaluji Heartbeat...`);
        
        providniApiHeartbeat().catch(err => console.error("❌ Chyba při reaktivním spuštění:", err));

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK - Reaktivní backend mozek hlídá stadion.");
    }).listen(PORT, () => {
        console.log(`🌐 HEALTH CHECK PROBE: Síťový port ${PORT} bezpečně otevřen a připraven pro Render.`);
    });

    inicializujLiveFirestoreStreams();

    console.log("🛰️ BOOT STRAP: Rádiové streamy nahozeny. Čekám na kompletní doručení signálů od pošťáka...");
}

startEnterpriseApplication();
