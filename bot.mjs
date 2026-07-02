// =========================================================================
// 🤖 TIPNI TO! - TRVALÝ STAVOVÝ BACKEND DAEMON V2.5.0 (bot.mjs)
// =========================================================================
import admin from "firebase-admin";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import process from "process";
import http from "http";

// --- ⚙️ PROSTŘEDÍ A KONFIGURACE (Environment Variables) ---
const LEAGUE_ID = process.env.LEAGUE_ID || "WC";
const LEAGUE_NAME = process.env.LEAGUE_NAME || "MS ve fotbale";
const SEZONA_ID = "2025_2026";
const LIGA_KLIC = LEAGUE_NAME.replace(/ /g, "_");
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const PORT = process.env.PORT || 8080;

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
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// --- 🧠 IN-MEMORY RAM STATE (Stavová paměť daemona) ---
const RAM_USERS_PROFILES = {}; 
const RAM_USERS_TIPS = {};     
const RAM_CENTRAL_MATCHES = {};
const PROCESSED_FREEZE_MATCHES = new Set(); 

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
    "Ghana": "Ghana"
};

// --- 🧮 POSVÁTNÁ MATEMATIKA BODŮ ---
const vypocitejBodyZapasuLocal = (tipDomaci, tipHoste, realDomaci, realHoste, tipPostup, realPostup, isPlayoff) => {
    const tDom = parseInt(tipDomaci); const tHos = parseInt(tipHoste);
    const rDom = parseInt(realDomaci); const rHos = parseInt(realHoste);
    if (isNaN(tDom) || isNaN(tHos) || isNaN(rDom) || isNaN(rHos)) return 0;

    if (tDom === rDom && tHos === rHos) {
        let body = 6;
        if (isPlayoff && rDom === rHos && realPostup && tipPostup && tipPostup === realPostup) body += 1;
        return body;
    }
    if (rDom === rHos && tDom === tHos) {
        let body = 3;
        if (isPlayoff && realPostup && tipPostup && tipPostup === realPostup) body += 1;
        return body;
    }
    const tipRozdil = tDom - tHos; const realRozdil = rDom - rHos;
    const spravnaTendence = (tipRozdil > 0 && realRozdil > 0) || (tipRozdil < 0 && realRozdil < 0);
    if (spravnaTendence) {
        if ((tDom === rDom || tHos === rHos) || (tipRozdil === realRozdil)) return 3;
        return 2;
    }
    if (tDom === rDom || tHos === rHos) return 1;
    return 0;
};

// --- 📤 DISTRIBUČNÍ SYSTÉM (R2 UPLOAD) ---
async function uploadToR2(filename, jsonData) {
    try {
        const bodyText = JSON.stringify(jsonData, null, 2);
        await r2Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: filename,
            Body: bodyText,
            ContentType: "application/json"
        }));
    } catch (err) {
        console.error(`❌ Chyba distribuce souboru ${filename} do R2:`, err);
    }
}

// --- 📡 DATA PIPELINES (Firestore Real-time Sync) ---
let apiHeartbeatStartedGlobal = false;
const readySignalsGlobal = { users: false, tips: false, matches: false };

// 🪐 EVENT-DRIVEN POŠŤÁK: Hlídá synchronní připravenost RAM paměti bez hnusných timeoutů!
function emitReadySignalGlobal(streamName) {
    if (!readySignalsGlobal[streamName]) {
        readySignalsGlobal[streamName] = true;
        console.log(`📡 SIGNÁL POŠŤÁKA: Stream [${streamName}] kompletně natekl ze sítě do RAM paměti.`);
        
        // V momentě, kdy jsou všechny 3 hlavní streamy v pořádku stažené, bezpečně odpalujeme heartbeat loop
        if (readySignalsGlobal.users && readySignalsGlobal.tips && readySignalsGlobal.matches && !apiHeartbeatStartedGlobal) {
            apiHeartbeatStartedGlobal = true;
            console.log("🚀 POŠŤÁK ODPALUJE HLAVNÍ LOOP: Všechna data jsou bezpečně v RAM. Spouštím neprůstřelný sportovní Heartbeat!");
            providniApiHeartbeat();
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
            const data = change.doc.data();
            if (change.type === "removed") {
                delete RAM_USERS_PROFILES[uid];
            } else {
                if (data.leagues && data.leagues.includes(LEAGUE_NAME)) {
                    RAM_USERS_PROFILES[uid] = {
                        email: (data.email || "").trim().toLowerCase(),
                        nickname: data.nickname || (data.email || "").split('@')[0]
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
                  const souteze = sData.souteze || {};
                  const soutezData = souteze[LIGA_KLIC] || {};
                  
                  RAM_USERS_TIPS[uid] = {
                      tipy: soutezData.tipy || {},
                      bonusy: soutezData.bonusy || {}
                  };
              }
          });
          rekonstruujAgregaty();
          emitReadySignalGlobal("tips");
      }, (err) => console.error("❌ Kritický výpadek databázového streamu sezón:", err));

    console.log(`📡 Spouštím permanentní synchronizaci zápasů z Firestore pro Admin Panel...`);
    db.collection("ligy").doc(LEAGUE_NAME).collection("zapasy").onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
            const matchId = change.doc.id;
            const data = change.doc.data() || {};
            
            if (change.type === "removed") {
                delete RAM_CENTRAL_MATCHES[matchId];
            } else {
                const stary = RAM_CENTRAL_MATCHES[matchId] || {};
                
                let isoDatum = stary.datum || new Date().toISOString();
                if (data.datum) {
                    isoDatum = typeof data.datum.toDate === 'function' ? data.datum.toDate().toISOString() : new Date(data.datum).toISOString();
                }

                RAM_CENTRAL_MATCHES[matchId] = {
                    domaci: data.domaci || stary.domaci || "Neznámý",
                    hoste: data.hoste || stary.hoste || "Neznámý",
                    datum: isoDatum,
                    isPlayoff: data.isPlayoff !== undefined ? data.isPlayoff : (stary.isPlayoff || false),
                    kolo: data.kolo || stary.kolo || "Šampionát",
                    vysledek_domaci: data.vysledek_domaci !== undefined ? data.vysledek_domaci : stary.vysledek_domaci,
                    vysledek_hoste: data.vysledek_hoste !== undefined ? data.vysledek_hoste : stary.vysledek_hoste,
                    apiStatus: data.apiStatus || stary.apiStatus || "SCHEDULED",
                    postup: data.postup || stary.postup || ""
                };
            }
        });
        rekonstruujAgregaty();
        emitReadySignalGlobal("matches");
    }, (err) => console.error("❌ Chyba streamu zápasů z Firestore:", err));
}

// --- 🧮 AGREGÁTOR PAMĚTI ---
async function rekonstruujAgregaty(forceWriteHistory = false) {
    const timestampNow = new Date().toISOString();

    // 🛡️ ULTRA-PROFI ASYNCHRONNÍ JISTIČ (Konec penalizacím -54b):
    // Pokud Firestore streamy ještě nedokončily prvotní stažení uživatelů nebo tipů,
    // okamžitě výpočet stornujeme. Nedovolíme systému generovat falešné mínusové body na Cloudflare.
    if (Object.keys(RAM_USERS_PROFILES).length === 0 || Object.keys(RAM_USERS_TIPS).length === 0) {
        console.log("⏳ JISTIČ AGREGÁTU: Paměť RAM se stále plní ze sítě. Stornuji výpočet žebříčku pro ochranu bodů...");
        return;
    }

    const leagueDoc = await db.collection("ligy").doc(LEAGUE_NAME).get().catch(() => null);
    const realLeagueData = leagueDoc && leagueDoc.exists ? leagueDoc.data() : null;

    const zebricekMapa = {};
    const mapaPrezdivek = {};

    Object.keys(RAM_USERS_PROFILES).forEach(uid => {
        const p = RAM_USERS_PROFILES[uid];
        mapaPrezdivek[p.email] = p.nickname;
        zebricekMapa[p.email] = {
            uid: uid, email: p.email, nickname: p.nickname, celkemBodu: 0, natipovaneVyhodnocene: 0, nenatipovaneVyhodnocene: 0, presneVysledkyCount: 0,
            celkemBoduLive: 0, natipovaneVyhodnoceneLive: 0, nenatipovaneVyhodnoceneLive: 0, presneVysledkyCountLive: 0,
            bodyPoKolech: {}, nejStrelec: '–', vitezMs: '–', nejviceBoduVKole: 0
        };

        const uTips = RAM_USERS_TIPS[uid] || { tipy: {}, bonusy: {} };
        zebricekMapa[p.email].vitezMs = uTips.bonusy?.vitez || '–';
        zebricekMapa[p.email].nejStrelec = uTips.bonusy?.strelec || '–';
    });

    if (realLeagueData && (realLeagueData.vitez || realLeagueData.strelec)) {
        Object.keys(zebricekMapa).forEach(em => {
            let bonusBody = (LEAGUE_NAME === "MS ve fotbale") ? 8 : 10;
            if (realLeagueData.vitez && zebricekMapa[em].vitezMs.toLowerCase() === realLeagueData.vitez.toLowerCase()) {
                zebricekMapa[em].celkemBodu += bonusBody; zebricekMapa[em].celkemBoduLive += bonusBody;
            }
            if (realLeagueData.strelec && zebricekMapa[em].nejStrelec.toLowerCase() === realLeagueData.strelec.toLowerCase()) {
                zebricekMapa[em].celkemBodu += bonusBody; zebricekMapa[em].celkemBoduLive += bonusBody;
            }
        });
    }

    // 🧠 DETEKCE AKTUÁLNÍHO PROBÍHAJÍCÍHO KOLA V RAM
    let aktivniKolo = "1";
    const zapasySerazene = Object.values(RAM_CENTRAL_MATCHES).sort((a, b) => {
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

    // 🧮 VÝPOČET MAXIMÁLNÍCH MOŽNÝCH BODŮ PRO AKTIVNÍ/UKONČENÉ UTKÁNÍ
    let maxMoznychBoduZapasu = 0;
    Object.values(RAM_CENTRAL_MATCHES).forEach(zapas => {
        const jeVyhodnoceny = (zapas.vysledek_domaci !== undefined && zapas.apiStatus !== "IN_PLAY" && zapas.apiStatus !== "PAUSED");
        const jeBežícíLive = (zapas.apiStatus === "IN_PLAY" || zapas.apiStatus === "PAUSED");
        if (jeVyhodnoceny || jeBežícíLive) {
            if (LEAGUE_NAME === "MS ve fotbale") {
                maxMoznychBoduZapasu += (zapas.isPlayoff && zapas.vysledek_domaci === zapas.vysledek_hoste) ? 7 : 6;
            } else {
                maxMoznychBoduZapasu += 3;
            }
        }
    });

    const jeFotbaloveMS = (LEAGUE_NAME === "MS ve fotbale");

    // Reinicializace a pojištění polí v RAM pro stoprocentní zrcadlení cloudu
    Object.keys(zebricekMapa).forEach(email => {
        zebricekMapa[email].bodyPoKolechLive = {};
        zebricekMapa[email].bodyZapasuCelkem = 0;
        zebricekMapa[email].bodyZapasuCelkemLive = 0;
    });

    Object.keys(RAM_CENTRAL_MATCHES).forEach(matchId => {
        const zapas = RAM_CENTRAL_MATCHES[matchId];
        const jeVyhodnoceny = (zapas.vysledek_domaci !== undefined && zapas.apiStatus !== "IN_PLAY" && zapas.apiStatus !== "PAUSED");
        const jeBežícíLive = (zapas.apiStatus === "IN_PLAY" || zapas.apiStatus === "PAUSED");
        const jeLiveNeboVyhodnoceny = (zapas.vysledek_domaci !== undefined) || jeBežícíLive;

        const vDomaci = zapas.vysledek_domaci !== undefined && zapas.vysledek_domaci !== null ? zapas.vysledek_domaci : 0;
        const vHoste = zapas.vysledek_hoste !== undefined && zapas.vysledek_hoste !== null ? zapas.vysledek_hoste : 0;

        Object.keys(RAM_USERS_PROFILES).forEach(uid => {
            const em = RAM_USERS_PROFILES[uid].email;
            if (!zebricekMapa[em]) return;

            const uTips = RAM_USERS_TIPS[uid] ? RAM_USERS_TIPS[uid].tipy : {};
            const uTip = uTips[matchId];

            if (jeVyhodnoceny) {
                let bodyZapasu = 0;
                if (uTip) {
                    bodyZapasu = vypocitejBodyZapasuLocal(uTip.tip_domaci, uTip.tip_hoste, zapas.vysledek_domaci, zapas.vysledek_hoste, uTip.postup, zapas.postup, zapas.isPlayoff);
                    zebricekMapa[em].celkemBodu += bodyZapasu; zebricekMapa[em].natipovaneVyhodnocene++;
                    if (parseInt(uTip.tip_domaci) === parseInt(zapas.vysledek_domaci) && parseInt(uTip.tip_hoste) === parseInt(zapas.vysledek_hoste)) zebricekMapa[em].presneVysledkyCount++;
                } else {
                    if (jeFotbaloveMS) { bodyZapasu = -1; zebricekMapa[em].celkemBodu += bodyZapasu; }
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
                    bodyZapasuLive = vypocitejBodyZapasuLocal(uTip.tip_domaci, uTip.tip_hoste, vDomaci, vHoste, uTip.postup, zapas.postup, zapas.isPlayoff);
                    zebricekMapa[em].celkemBoduLive += bodyZapasuLive; zebricekMapa[em].natipovaneVyhodnoceneLive++;
                    if (parseInt(uTip.tip_domaci) === parseInt(vDomaci) && parseInt(uTip.tip_hoste) === parseInt(vHoste)) zebricekMapa[em].presneVysledkyCountLive++;
                } else {
                    if (jeFotbaloveMS) { bodyZapasuLive = -1; zebricekMapa[em].celkemBoduLive += bodyZapasuLive; }
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

    // 🧠 SENIORNÍ DETEKCE MAXIMA: Najdeme nejvyšší bodový zisk a k němu přibalíme i název kola
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

    // 🏆 GENERÁTOR STATICKÝCH REKORDŮ (Základní odehrané zápasy)
    const vsechnyPresne = Object.keys(zebricekMapa).map(email => ({
        nickname: zebricekMapa[email].nickname,
        count: zebricekMapa[email].presneVysledkyCount
    })).filter(p => p.count > 0);
    const unikatniPresneBadges = [...new Set(vsechnyPresne.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
    const top3Presne = unikatniPresneBadges.map(count => {
        const nicks = vsechnyPresne.filter(p => p.count === count).map(p => p.nickname);
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

    // 🔥 🏆 GENERÁTOR REÁLNÝCH LIVE REKORDŮ (Počítá průběžné stavy během zápasů)
    const vsechnyPresneLive = Object.keys(zebricekMapa).map(email => ({
        nickname: zebricekMapa[email].nickname,
        count: zebricekMapa[email].presneVysledkyCountLive
    })).filter(p => p.count > 0);
    const unikatniPresneBadgesLive = [...new Set(vsechnyPresneLive.map(p => p.count))].sort((a, b) => b - a).slice(0, 3);
    const top3PresneLive = unikatniPresneBadgesLive.map(count => {
        const nicks = vsechnyPresneLive.filter(p => p.count === count).map(p => p.nickname);
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

    // 🧮 MAPOVÁNÍ FINÁLNÍCH POLÍ S EFEKTIVITOU, AKTUÁLNÍM KOLEM A SPRAVEDLIVÝM TIE-BREAKEREM
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

    // 🧠 VÝPOČET VIRTUÁLNÍHO POSUNU (DELTA): Porovnáme indexy mezi stabilní a live tabulkou
    zebricekLivePole.forEach((pLive, idxLive) => {
        const idxOfficial = zebricekPole.findIndex(pOff => pOff.uid === pLive.uid);
        pLive.poziceDelta = idxOfficial !== -1 ? (idxOfficial - idxLive) : 0;
    });

    const liveMatchIds = Object.keys(RAM_CENTRAL_MATCHES).filter(id => {
        const z = RAM_CENTRAL_MATCHES[id];
        return z.apiStatus === "IN_PLAY" || z.apiStatus === "PAUSED";
    });

    // 📊 SESTAVENÍ FINÁLNÍHO NEPRŮSTŘELNÉHO DATA-BALÍČKU PRO FRONTEND
    const leaderboardJson = {
        zebricek: zebricekPole, 
        zebricekLive: zebricekLivePole, 
        isLive: liveMatchIds.length > 0, 
        mapaPrezdivek: mapaPrezdivek,
        top3Presne: top3Presne,
        top3Kola: top3Kola,
        top3PresneLive: top3PresneLive, // 🔥 Posíláme reálné LIVE trofeje přesnosti
        top3KolaLive: top3KolaLive,     // 🔥 Posíláme reálné LIVE trofeje kol
        top3AktualniKolo: top3AktualniKolo,
        aktivniKoloText: aktivniKolo,
        aktualizovano: timestampNow
    };

    // 🚀 Odesíláme bleskově na Cloudflare R2
    await uploadToR2("leaderboard.json", leaderboardJson);

    const rozpisJson = { zapasyMapa: RAM_CENTRAL_MATCHES, aktualizovano: timestampNow };
    await uploadToR2("rozpis.json", rozpisJson);

    if (forceWriteHistory) {
        for (const uid of Object.keys(RAM_USERS_PROFILES)) {
            const hracovyTipyVsechny = RAM_USERS_TIPS[uid] ? RAM_USERS_TIPS[uid].tipy : {};
            const hracovyTipyOdemcene = {};

            Object.keys(hracovyTipyVsechny).forEach(mId => {
                const zapas = RAM_CENTRAL_MATCHES[mId];
                if (zapas && new Date(zapas.datum) <= new Date()) {
                    hracovyTipyOdemcene[mId] = hracovyTipyVsechny[mId];
                }
            });

            const historieJson = { mapaTipu: hracovyTipyOdemcene, vytvoreno: timestampNow };
            await uploadToR2(`historie_hrace_${uid}.json`, historieJson);
        }
    }

    // 📡 LIVE PULS SYNC: Bot jemně drcne do Firestore a všem lidem na webu okamžitě naskočí změny!
    try {
        const pulsRef = db.collection('ligy').doc(LEAGUE_NAME).collection('stav').doc('puls');
        await pulsRef.set({
            verzeRozpisu: admin.firestore.FieldValue.increment(1),
            verzeZebricku: admin.firestore.FieldValue.increment(1),
            aktualizovano: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log("📡 PULS SYNC: Firestore puls úspěšně aktualizován. Frontend dostal signál k reloadu.");
    } catch (pulsErr) {
        console.error("❌ Selhal zápis pulsu do Firestore:", pulsErr);
    }
}

async function providniApiHeartbeat() {
    console.log(`[${new Date().toLocaleTimeString()}] ⏱️ Heartbeat kontrola sportovního API...`);
    
    // ⛔ BEZPEČNOSTNÍ STOPKA ZE SUPER ADMIN PANELU
    if (!RAM_BOT_CONFIG.active) {
        console.log("⛔ BOT MANUÁLNĚ VYPNUT: Ovládací panel hlásí force_stop. Spím a nezatěžuji API...");
        setTimeout(providniApiHeartbeat, RAM_BOT_CONFIG.waitInterval * 60 * 1000);
        return;
    }

    if (!API_KEY) {
        console.log("ℹ️ Běží čistě Firestore režim (Chybí API_KEY, sportovní API přeskočeno).");
        return;
    }

    try {
        const response = await fetch(`https://api.football-data.org/v4/competitions/${LEAGUE_ID}/matches`, {
            headers: { "X-Auth-Token": API_KEY }
        });
        if (!response.ok) throw new Error(`API error: ${response.status}`);
        
        const apiData = await response.json();
        const matches = apiData.matches || [];
        const nyni = new Date();

        let obsahujeAktivniZapas = false;
        let dosloKStavoveZmene = false;
        let minRozdilDoZapasu = Infinity;
        let pristiZapasIso = null; // 👑 PŘESUNUTO SEM: Bezpečný vnější rozsah pro ochranu před ReferenceError

        for (const match of matches) {
            const apiId = String(match.id);
            const status = match.status;
            // 🧠 NEPRŮSTŘELNÝ MILISEKUNDOVÝ JISTIČ + API TRUMP
            const nyniMilisekundy = Date.now();
            const startZapasuMilisekundy = Date.parse(match.utcDate);
            const rozdilMinut = (startZapasuMilisekundy - nyniMilisekundy) / (1000 * 60);

            // Pokud API hlásí live zápas, ignorujeme hodiny a okamžitě zamykáme
            const uzSeHrajePodleAPI = status === "IN_PLAY" || status === "PAUSED" || status === "LIVE";
            const matchStarted = uzSeHrajePodleAPI || (nyniMilisekundy >= startZapasuMilisekundy);

            // 🚨 AUTOMATICKÝ JISTIČ PROTI ZPOŽDĚNÍ API:
            // Pokud zápas podle času už odstartoval (rozdilMinut <= 0), ale API ho ještě 
            // neuzavřelo (status !== "FINISHED"), natvrdo držíme bojový režim bota!
            if (status !== "FINISHED" && rozdilMinut <= 0) {
                obsahujeAktivniZapas = true;
            }

            if (rozdilMinut > 0 && rozdilMinut < minRozdilDoZapasu) {
                minRozdilDoZapasu = rozdilMinut;
                pristiZapasIso = match.utcDate; // Čistý zápis do sdílené vnější proměnné
            }

            const rawDomaci = match.homeTeam?.name || "Neznámý";
            const rawHoste = match.awayTeam?.name || "Neznámý";
            const domaci = slovnikTymu[rawDomaci] || rawDomaci;
            const hoste = slovnikTymu[rawHoste] || rawHoste;
            const isPlayoff = match.stage !== "GROUP_STAGE";

            let golyDomaci = undefined; let golyHoste = undefined; let postupVal = "";
            const jeZapasAktivni = status === "FINISHED" || status === "IN_PLAY" || status === "PAUSED";
            
            // 🛡️ PARSER SKÓRE: Pojistíme každý jeden krok. Pokud API u neodehraného zápasu nepošle score, 
            // JavaScript s otazníky nespadne, bezpečně to přeskočí a bot může v klidu běžet dál.
            if (jeZapasAktivni && match.score && match.score.fullTime && match.score.fullTime.home !== null) {
                // 👑 ENTERPRISE PARSER: Pokud se hraje prodloužení (extraTime), odečteme jeho góly od fullTime, abychom dostali stav po 90. minutě
                if (isPlayoff && match.score.extraTime && match.score.extraTime.home !== null && match.score.extraTime.home !== undefined) {
                    golyDomaci = parseInt(match.score.fullTime.home) - parseInt(match.score.extraTime.home);
                    golyHoste = parseInt(match.score.fullTime.away) - parseInt(match.score.extraTime.away);
                } else {
                    golyDomaci = parseInt(match.score.fullTime.home);
                    golyHoste = parseInt(match.score.fullTime.away);
                }
                if (isPlayoff && match.score.winner) {
                    if (match.score.winner === "HOME_TEAM") postupVal = "domaci";
                    if (match.score.winner === "AWAY_TEAM") postupVal = "hoste";
                }
            }

            if (status === "IN_PLAY" || status === "PAUSED") {
                obsahujeAktivniZapas = true;
            }

            // --- 🔒 JISTIČ TIPOVACÍ BOUŘE: Výkop zápasu (T-0 minut chirurgicky přesně) ---
            // Zamykáme pouze zápasy, které nejsou kompletně hotové (FINISHED) – konec R2 spamu po restartu!
            if (status !== "FINISHED" && matchStarted && !PROCESSED_FREEZE_MATCHES.has(apiId)) {
                console.log(`🔒 LOCK T-0: Právě nastal čas výkopu zápasu ${domaci} – ${hoste}. Zmrazuji tipy!`);
                
                const tipyProZapasPole = [];
                Object.keys(RAM_USERS_PROFILES).forEach(uid => {
                    const em = RAM_USERS_PROFILES[uid].email;
                    const uTips = RAM_USERS_TIPS[uid] ? RAM_USERS_TIPS[uid].tipy : {};
                    const uTip = uTips[apiId];
                    if (uTip && uTip.tip_domaci !== undefined) {
                        tipyProZapasPole.push({
                            userEmail: em,
                            nickname: RAM_USERS_PROFILES[uid].nickname,
                            tip_domaci: parseInt(uTip.tip_domaci),
                            tip_hoste: parseInt(uTip.tip_hoste),
                            postup: uTip.postup || ''
                        });
                    }
                });

                await uploadToR2(`spy_zapas_${apiId}.json`, { tipy: tipyProZapasPole, aktualizovano: nyni.toISOString() });
                PROCESSED_FREEZE_MATCHES.add(apiId);
                dosloKStavoveZmene = true;
            }

            const stary = RAM_CENTRAL_MATCHES[apiId];
            if (!stary || stary.apiStatus !== status || stary.vysledek_domaci !== golyDomaci || stary.vysledek_hoste !== golyHoste || stary.postup !== postupVal) {
                dosloKStavoveZmene = true;
            }

            const stage = match.stage || "";
            // 🧠 TVOJE PRAVIDLO PRO 4. KOLO: Pokud API nebo starý záznam hlásí LAST_32 nebo LAST_16,
            // jedná se o tvůj balík 24 zápasů, kterým nekompromisně vnutíme název "4. kolo".
            const jeToCtyrteKolo = stage === "LAST_32" || stage === "LAST_16" || stary?.kolo === "LAST_32" || stary?.kolo === "LAST_16" || stary?.kolo === "4. kolo";
            
            let spravneKoloTurnaje = "Šampionát";
            if (jeToCtyrteKolo) {
                spravneKoloTurnaje = "4. kolo";
            } else if (isPlayoff) {
                spravneKoloTurnaje = "Play-off"; // Od čtvrtfinále dál
            } else if (match.matchday) {
                spravneKoloTurnaje = `Kolo ${match.matchday}`;
            }

            // 🛡️ LIKVIDACE OTAZNÍKŮ: Pokud je v paměti nebo v DB "Neznámý", ale API už zná reálný tým, přepíšeme ho.
            const finalDomaci = (!stary || stary.domaci === "Neznámý") ? domaci : stary.domaci;
            const finalHoste = (!stary || stary.hoste === "Neznámý") ? hoste : stary.hoste;

            // 💾 AUTOMATICKÝ ZPĚTNÝ ZÁPIS: Jakmile zápas skončí, bot propíše skóre a správný název kola do tvého Firestore.
            // Tím se ti Kolo 3 i 4. kolo začnou okamžitě samy vyhodnocovat přímo v databázi!
            const detekovanNovyRozlosovanyTym = stary && (stary.domaci === "Neznámý" && domaci !== "Neznámý");
            const jeUkoncenBezVysledkuVDB = status === "FINISHED" && golyDomaci !== undefined && golyHoste !== undefined && (!stary || stary.vysledek_domaci === undefined);
            const potrebujeOpravitKoloVDB = stary && (stary.kolo === "LAST_32" || stary.kolo === "LAST_16" || (stary.kolo === "Play-off" && jeToCtyrteKolo));

            if (detekovanNovyRozlosovanyTym || jeUkoncenBezVysledkuVDB || potrebujeOpravitKoloVDB) {
                console.log(`💾 AUTO-SYNC FIREBASE: Aktualizuji zápas ${finalDomaci} - ${finalHoste} na Kolo: ${spravneKoloTurnaje}`);
                const syncPayload = {
                    domaci: finalDomaci,
                    hoste: finalHoste,
                    apiStatus: status,
                    kolo: spravneKoloTurnaje,
                    isPlayoff: isPlayoff
                };
                if (golyDomaci !== undefined) syncPayload.vysledek_domaci = golyDomaci;
                if (golyHoste !== undefined) syncPayload.vysledek_hoste = golyHoste;
                if (postupVal) syncPayload.postup = postupVal;

                db.collection("ligy").doc(LEAGUE_NAME).collection("zapasy").doc(apiId).set(syncPayload, { merge: true })
                    .catch(e => console.error("❌ Chyba synchronizace do Firebase:", e));
            }

            // Bezpečné uložení do vnitřní in-memory RAM paměti bota pro bleskový výpočet žebříčku
            RAM_CENTRAL_MATCHES[apiId] = {
                domaci: finalDomaci,
                hoste: finalHoste,
                datum: match.utcDate,
                isPlayoff: stary?.isPlayoff !== undefined ? stary.isPlayoff : isPlayoff,
                kolo: spravneKoloTurnaje,
                vysledek_domaci: golyDomaci !== undefined ? golyDomaci : stary?.vysledek_domaci,
                vysledek_hoste: golyHoste !== undefined ? golyHoste : stary?.vysledek_hoste,
                apiStatus: status,
                postup: postupVal || stary?.postup || ""
            };
        } // 🌟 V pořádku uzavřený velký cyklus matches 'for (const match of matches)' bez zbloudilých elementů!

        if (dosloKStavoveZmene || obsahujeAktivniZapas) {
            console.log("⚡ Detekována změna skóre. Přepočítávám RAM registry...");
            await rekonstruujAgregaty(dosloKStavoveZmene);
        }

        // 📡 RADAR SYNC: Zápis jednoho koordinačního dokumentu pro ultra-levný provoz Cloud Functions
        try {
            await db.collection("ligy").doc(LEAGUE_NAME).collection("stav").doc("radar").set({
                beziLive: obsahujeAktivniZapas,
                pristiZapasUtc: pristiZapasIso || null,
                aktualizovano: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            console.log("📡 RADAR SYNC: Řídicí maják pro Cloud Function úspěšně zaktualizován v DB.");
        } catch (radarErr) {
            console.error("❌ Selhal zápis radarových dat do Firestore:", radarErr);
        }

        // 📡 REAKTIVNÍ CLOUDOVÁ DIAGNOSTIKA: Kontrolu času a spánku plně přebírá Firebase Chronos
        const jeZapasV_OkneBojovehoRezimu = minRozdilDoZapasu <= 6;
        if (obsahujeAktivniZapas || jeZapasV_OkneBojovehoRezimu) {
            console.log(`🚀 STATUS: Zápas aktivně běží nebo se blíží výkop. Systém je v pohotovosti.`);
        } else {
            console.log(`💤 STATUS: Klid zbraní. Nejbližší zápas je za ${Math.round(minRozdilDoZapasu)} min. Vypínám motor.`);
        }

    } catch (err) {
        console.error("❌ Kritická chyba v heartbeat smyčce:", err);
    }
}

// --- 🌐 LIFECYCLE INITIALIZATION BOOTSTRAP ---
async function startEnterpriseApplication() {
    console.log("=========================================================================");
    console.log("👑 CLOUD-NATIVE DAEMON: Inicializuji životní cyklus trvalého mozku...");
    console.log("=========================================================================");

    // 1. Spustíme reaktivní spouštěcí server propojený na Firebase Chronos dispečink
    http.createServer((req, res) => {
        console.log(`📡 PING PŘIJAT: Cloudový plánovač udeřil do serveru. Probouzím RAM a odpaluji Heartbeat...`);
        
        // Spustíme kontrolu API asynchronně na pozadí, ať neblokujeme rychlou HTTP odpověď 200 OK pro Firebase
        providniApiHeartbeat().catch(err => console.error("❌ Chyba při reaktivním spuštění:", err));

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK - Reaktivní backend mozek hlídá stadion.");
    }).listen(PORT, () => {
        console.log(`🌐 HEALTH CHECK PROBE: Síťový port ${PORT} bezpečně otevřen a připraven pro Render.`);
    });

    // 2. Připojíme dlouhoběžící vnitřní Firestore streamy
    inicializujLiveFirestoreStreams();

    console.log("🛰️ BOOT STRAP: Rádiové streamy nahozeny. Čekám na kompletní doručení signálů od pošťáka...");
}

// Odpálení aplikace
startEnterpriseApplication();
