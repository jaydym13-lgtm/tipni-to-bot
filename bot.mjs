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
function inicializujLiveFirestoreStreams() {
    console.log("👥 Spouštím permanentní RAM synchronizaci uživatelských účtů...");

    // 🎛️ ŽIVÝ RADAR PRO OVLÁDÁNÍ BOTA (Bleskově naslouchá tvému Super Admin panelu bez restartů)
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
    });

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

                // 🛡️ JISTIČ DAT: Firestore stream smí zapsat výsledek jen tehdy, pokud v DB reálně existuje.
                // Pokud je v DB prázdno (undefined), zachováme hodnotu, kterou bot právě stáhl živě z API.
                RAM_CENTRAL_MATCHES[matchId] = {
                    domaci: data.domaci || stary.domaci || "Neznámý",
                    hoste: data.hoste || stary.hoste || "Neznámý",
                    datum: isoDatum,
                    isPlayoff: data.isPlayoff !== undefined ? data.isPlayoff : (stary.isPlayoff || false),
                    kolo: data.kolo || stary.kolo || "Šampionát",
                    vysledek_domaci: data.vysledek_domaci !== undefined ? data.vysledek_domaci : stary.vysledek_domaci,
                    vysledek_hoste: data.vysledek_hoste !== undefined ? data.vysledek_hoste : stary.vysledek_hoste,
                    apiStatus: data.apiStatus || stary.apiStatus || "SCHEDULED", // Změna z FINISHED na SCHEDULED!
                    postup: data.postup || stary.postup || ""
                };
            }
        });
        rekonstruujAgregaty();
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

    Object.keys(RAM_CENTRAL_MATCHES).forEach(matchId => {
        const zapas = RAM_CENTRAL_MATCHES[matchId];
        const jeVyhodnoceny = (zapas.vysledek_domaci !== undefined && zapas.apiStatus !== "IN_PLAY" && zapas.apiStatus !== "PAUSED");
        const jeLiveNeboVyhodnoceny = (zapas.vysledek_domaci !== undefined);

        Object.keys(RAM_USERS_PROFILES).forEach(uid => {
            const em = RAM_USERS_PROFILES[uid].email;
            if (!zebricekMapa[em]) return;

            const uTips = RAM_USERS_TIPS[uid] ? RAM_USERS_TIPS[uid].tipy : {};
            const uTip = uTips[matchId];

            if (jeVyhodnoceny) {
                let body = 0;
                if (uTip) {
                    body = vypocitejBodyZapasuLocal(uTip.tip_domaci, uTip.tip_hoste, zapas.vysledek_domaci, zapas.vysledek_hoste, uTip.postup, zapas.postup, zapas.isPlayoff);
                    zebricekMapa[em].celkemBodu += body; zebricekMapa[em].natipovaneVyhodnocene++;
                    if (parseInt(uTip.tip_domaci) === zapas.vysledek_domaci && parseInt(uTip.tip_hoste) === zapas.vysledek_hoste) zebricekMapa[em].presneVysledkyCount++;
                } else {
                    if (LEAGUE_NAME === "MS ve fotbale") { body = -1; zebricekMapa[em].celkemBodu += body; }
                    zebricekMapa[em].nenatipovaneVyhodnocene++;
                }
                if (zapas.kolo) {
                    const klic = String(zapas.kolo).trim();
                    zebricekMapa[em].bodyPoKolech[klic] = (zebricekMapa[em].bodyPoKolech[klic] || 0) + body;
                }
            }

            if (jeLiveNeboVyhodnoceny) {
                if (uTip) {
                    const bodyL = vypocitejBodyZapasuLocal(uTip.tip_domaci, uTip.tip_hoste, zapas.vysledek_domaci || 0, zapas.vysledek_hoste || 0, uTip.postup, zapas.postup, zapas.isPlayoff);
                    zebricekMapa[em].celkemBoduLive += bodyL; zebricekMapa[em].natipovaneVyhodnoceneLive++;
                } else {
                    if (LEAGUE_NAME === "MS ve fotbale") zebricekMapa[em].celkemBoduLive += -1;
                    zebricekMapa[em].nenatipovaneVyhodnoceneLive++;
                }
            }
        });
    });

    Object.keys(zebricekMapa).forEach(em => {
        const kolaBodove = Object.values(zebricekMapa[em].bodyPoKolech);
        zebricekMapa[em].nejviceBoduVKole = kolaBodove.length > 0 ? Math.max(...kolaBodove) : 0;
    });

    let maxPresnychGlobal = 0; let maxBoduKoloGlobal = 0;
    Object.keys(zebricekMapa).forEach(em => {
        if (zebricekMapa[em].presneVysledkyCount > maxPresnychGlobal) maxPresnychGlobal = zebricekMapa[em].presneVysledkyCount;
        if (zebricekMapa[em].nejviceBoduVKole > maxBoduKoloGlobal) maxBoduKoloGlobal = zebricekMapa[em].nejviceBoduVKole;
    });
    let kraliPresnosti = []; let rekordmaniKola = [];
    Object.keys(zebricekMapa).forEach(em => {
        if (zebricekMapa[em].presneVysledkyCount === maxPresnychGlobal && maxPresnychGlobal > 0) kraliPresnosti.push(zebricekMapa[em].nickname);
        if (zebricekMapa[em].nejviceBoduVKole === maxBoduKoloGlobal && maxBoduKoloGlobal > 0) rekordmaniKola.push(zebricekMapa[em].nickname);
    });

    const zebricekPole = Object.values(zebricekMapa).map(h => ({
        uid: h.uid, email: h.email, nickname: h.nickname, celkemBodu: h.celkemBodu,
        natipovaneVyhodnocene: h.natipovaneVyhodnocene, nenatipovaneVyhodnocene: h.nenatipovaneVyhodnocene,
        presneVysledkyCount: h.presneVysledkyCount, nejviceBoduVKole: h.nejviceBoduVKole,
        vitezMs: h.vitezMs, nejStrelec: h.nejStrelec
    })).sort((a, b) => b.celkemBodu - a.celkemBodu);

    const zebricekLivePole = Object.values(zebricekMapa).map(h => ({
        uid: h.uid, email: h.email, nickname: h.nickname, celkemBodu: h.celkemBoduLive,
        natipovaneVyhodnocene: h.natipovaneVyhodnoceneLive, nenatipovaneVyhodnocene: h.nenatipovaneVyhodnoceneLive,
        presneVysledkyCount: h.presneVysledkyCountLive, nejviceBoduVKole: h.nejviceBoduVKole,
        vitezMs: h.vitezMs, nejStrelec: h.nejStrelec
    })).sort((a, b) => b.celkemBodu - a.celkemBodu);

    const liveMatchIds = Object.keys(RAM_CENTRAL_MATCHES).filter(id => {
        const z = RAM_CENTRAL_MATCHES[id];
        return z.apiStatus === "IN_PLAY" || z.apiStatus === "PAUSED";
    });

    const leaderboardJson = {
        zebricek: zebricekPole, zebricekLive: zebricekLivePole, isLive: liveMatchIds.length > 0, mapaPrezdivek: mapaPrezdivek,
        textKraliPresnosti: kraliPresnosti.length > 0 ? `${kraliPresnosti.join(', ')} (${maxPresnychGlobal}x)` : '–',
        textRekordmaniKola: rekordmaniKola.length > 0 ? `${rekordmaniKola.join(', ')} (${maxBoduKoloGlobal} b.)` : '–',
        aktualizovano: timestampNow
    };
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

        for (const match of matches) {
            const apiId = String(match.id);
            const status = match.status;
            const matchStarted = new Date(match.utcDate) <= nyni;
            const rozdilMinut = (new Date(match.utcDate) - nyni) / (1000 * 60);

            if (rozdilMinut > 0 && rozdilMinut < minRozdilDoZapasu) {
                minRozdilDoZapasu = rozdilMinut;
            }

            const rawDomaci = match.homeTeam?.name || "Neznámý";
            const rawHoste = match.awayTeam?.name || "Neznámý";
            const domaci = slovnikTymu[rawDomaci] || rawDomaci;
            const hoste = slovnikTymu[rawHoste] || rawHoste;
            const isPlayoff = match.stage !== "GROUP_STAGE";

            let golyDomaci = undefined; let golyHoste = undefined; let postupVal = "";
            const jeZapasAktivni = status === "FINISHED" || status === "IN_PLAY" || status === "PAUSED";
            
            if (jeZapasAktivni && match.score?.fullTime?.home !== null) {
                if (isPlayoff && match.score.regularTime?.home !== null) {
                    golyDomaci = parseInt(match.score.regularTime.home);
                    golyHoste = parseInt(match.score.regularTime.away);
                } else {
                    golyDomaci = parseInt(match.score.fullTime.home);
                    golyHoste = parseInt(match.score.fullTime.away);
                }
                if (isPlayoff) {
                    if (match.score.winner === "HOME_TEAM") postupVal = "domaci";
                    if (match.score.winner === "AWAY_TEAM") postupVal = "hoste";
                }
            }

            if (status === "IN_PLAY" || status === "PAUSED") {
                obsahujeAktivniZapas = true;
            }

            // --- 🔒 JISTIČ TIPOVACÍ BOUŘE: Výkop zápasu (T-0 minut chirurgicky přesně) ---
            if (matchStarted && !PROCESSED_FREEZE_MATCHES.has(apiId)) {
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

            // 🛡️ STRATEGICKÁ INJEKTÁŽ LIVE DAT (Stop mizení zápasů a kol):
            // Přepisujeme výhradně live parametry z trávníku. Tvoje struktura "Kolo 3" nebo "Play-off" z Firestore je 100% v bezpečí.
            if (RAM_CENTRAL_MATCHES[apiId]) {
                const stary = RAM_CENTRAL_MATCHES[apiId];
            if (!stary || stary.apiStatus !== status || stary.vysledek_domaci !== golyDomaci || stary.vysledek_hoste !== golyHoste || stary.postup !== postupVal) {
                dosloKStavoveZmene = true;
            }

            // 💾 AUTOMATICKÝ ZPĚTNÝ ZÁPIS DO FIREBASE: Jakmile reálný zápas skončí a ve Firestore chybí skóre,
            // bot ho tam sám propíše. Tím okamžitě vyhodnotí Kolo 3 i play-off přímo v databázi a uzavře otazníky!
            if (status === "FINISHED" && golyDomaci !== undefined && golyHoste !== undefined && (!stary || stary.vysledek_domaci === undefined)) {
                console.log(`💾 SYNC BACK TO FIREBASE: Zápas ${domaci} - ${hoste} skončil (${golyDomaci}:${golyHoste}). Zapisuji výsledek.`);
                db.collection("ligy").doc(LEAGUE_NAME).collection("zapasy").doc(apiId).set({
                    vysledek_domaci: golyDomaci,
                    vysledek_hoste: golyHoste,
                    apiStatus: "FINISHED",
                    postup: postupVal
                }, { merge: true }).catch(e => console.error("❌ Chyba zpětného zápisu do Firebase:", e));
            }

            // 🛡️ OCHRANA STRUKTURY KOLA: Zachováme text "Kolo 3" nebo "Play-off" načtený z Firestore.
            // API tam teď nebude moct natvrdo vnutit svůj surový anglický název (např. "ROUND OF 16").
            RAM_CENTRAL_MATCHES[apiId] = {
                domaci: stary?.domaci || domaci,
                hoste: stary?.hoste || hoste,
                datum: match.utcDate,
                isPlayoff: stary?.isPlayoff !== undefined ? stary.isPlayoff : isPlayoff,
                kolo: stary?.kolo || (isPlayoff ? "Play-off" : kolo),
                vysledek_domaci: golyDomaci !== undefined ? golyDomaci : stary?.vysledek_domaci,
                vysledek_hoste: golyHoste !== undefined ? golyHoste : stary?.vysledek_hoste,
                apiStatus: status,
                postup: postupVal || stary?.postup || ""
            };
        }

        } else {
                // 🆕 PRVOTNÍ INITIALIZACE: Pokud zápas v paměti RAM ještě vůbec neexistuje, bezpečně ho založíme
                dosloKStavoveZmene = true;
                RAM_CENTRAL_MATCHES[apiId] = {
                    domaci, hoste, datum: match.utcDate, isPlayoff,
                    kolo: isPlayoff ? "Play-off" : kolo,
                    vysledek_domaci: golyDomaci, vysledek_hoste: golyHoste,
                    apiStatus: status, postup: postupVal
                };
            }
        } // 🌟 FIX: Tahle klíčová závorka ti v kódu chyběla! Uzavírá velký cyklus 'for (const match of matches)'

        if (dosloKStavoveZmene || obsahujeAktivniZapas) {
            console.log("⚡ Detekována změna skóre. Přepočítávám RAM registry...");
            await rekonstruujAgregaty(dosloKStavoveZmene);
        }

        // ⏱️ CHIRURGICKÝ ČASOVÝ MANAŽER CYKLU (Synchronizace 6 -> 3 -> 0)
        const jeZapasV_OkneBojovehoRezimu = minRozdilDoZapasu <= 6;

        if (obsahujeAktivniZapas || jeZapasV_OkneBojovehoRezimu) {
            console.log(`🚀 BATTLE MODE: Tikám na ostro každé ${RAM_BOT_CONFIG.liveInterval} minuty.`);
            setTimeout(providniApiHeartbeat, RAM_BOT_CONFIG.liveInterval * 60 * 1000);
        } else {
            if (minRozdilDoZapasu <= 35) {
                const casDoBojovehoRezimu = minRozdilDoZapasu - 6;
                const finalniSpanekMinut = (casDoBojovehoRezimu > 0 && casDoBojovehoRezimu < RAM_BOT_CONFIG.waitInterval) 
                    ? casDoBojovehoRezimu 
                    : RAM_BOT_CONFIG.waitInterval;

                console.log(`⏳ ČEKÁNÍ: Zápas je blízko. Další kontrola situace za ${Math.round(finalniSpanekMinut)} minut.`);
                setTimeout(providniApiHeartbeat, finalniSpanekMinut * 60 * 1000);
            } else {
                console.log("💤 KLID ZBRANÍ: Dnes už nic blízkého nezačíná. Vypínám smyčku, Chronos mě včas vzbudí.");
            }
        }

    } catch (err) {
        console.error("❌ Chyba v heartbeat smyčce, zkouším za minutu:", err);
        setTimeout(providniApiHeartbeat, 60000);
    }
}

// --- 🌐 LIFECYCLE INITIALIZATION BOOTSTRAP ---
async function startEnterpriseApplication() {
    console.log("=========================================================================");
    console.log("👑 CLOUD-NATIVE DAEMON: Inicializuji životní cyklus trvalého mozku...");
    console.log("=========================================================================");

    // 1. Spustíme integrovaný Health Check Server pro Render
    http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK - Backend mozek hlídá stadion.");
    }).listen(PORT, () => {
        console.log(`🌐 HEALTH CHECK PROBE: Síťový port ${PORT} bezpečně otevřen a připraven pro Render.`);
    });

    // 2. Připojíme dlouhoběžící vnitřní Firestore streamy
    inicializujLiveFirestoreStreams();

    // 3. Odpálíme nekonečnou kontrolní smyčku okamžitě (Závora v RAM si počká sama na dokončení sítě)
    providniApiHeartbeat();
}

// Odpálení aplikace
startEnterpriseApplication();
