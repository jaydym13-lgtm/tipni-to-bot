// =========================================================================
// 🤖 TIPNI TO! - TRVALÝ STAVOVÝ BACKEND DAEMON V2.3.0 (bot.mjs)
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
              rekonstruujAgregaty();
          });
      }, (err) => console.error("❌ Kritický výpadek streamu sezón:", err));

    // 👑 NEPRŮSTŘELNÝ JIŠTIČ ŽEBŘÍČKU: Bot nyní poslouchá zápasy přímo z Firestore jako frontend!
    console.log(`⚽ Ladím permanentní stream zápasů z Firestore pro ligu: ${LEAGUE_NAME}...`);
    db.collection("ligy").doc(LEAGUE_NAME).collection("zapasy").onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
            const matchId = change.doc.id;
            const data = change.doc.data() || {};
            
            if (change.type === "removed") {
                delete RAM_CENTRAL_MATCHES[matchId];
            } else {
                const stary = RAM_CENTRAL_MATCHES[matchId] || {};
                
                // Konverze Firestore datumu na ISO string pro bezpečný parsing kdekoli
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
    }, (err) => console.error("❌ Kritický výpadek streamu zápasů z Firestore:", err));
}

// --- 🧮 AGREGÁTOR PAMĚTI ---
async function rekonstruujAgregaty(forceWriteHistory = false) {
    const timestampNow = new Date().toISOString();
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

// --- ⏱️ HEARTBEAT MANAGER (Sledování API & Dynamický spánek) ---
async function providniApiHeartbeat() {
    console.log(`[${new Date().toLocaleTimeString()}] ⏱️ Heartbeat kontrola sportovního API...`);
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

        for (const match of matches) {
            const apiId = String(match.id);
            const status = match.status;
            const matchStarted = new Date(match.utcDate) <= nyni;

            const rawDomaci = match.homeTeam?.name || "Neznámý";
            const rawHoste = match.awayTeam?.name || "Neznámý";
            const domaci = slovnikTymu[rawDomaci] || rawDomaci;
            const hoste = slovnikTymu[rawHoste] || rawHoste;
            const isPlayoff = match.stage !== "GROUP_STAGE";
            const kolo = match.matchday ? `Kolo ${match.matchday}` : (match.stage ? match.stage.replace(/_/g, ' ') : "Šampionát");

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

            // --- 🔒 JISTIČ TIPOVACÍ BOUŘE: Výkop zápasu ---
            if (matchStarted && !PROCESSED_FREEZE_MATCHES.has(apiId)) {
                console.log(`🔒 LOCK: Výkop zápasu ${domaci} – ${hoste}. Zmrazuji tipy.`);
                
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

            RAM_CENTRAL_MATCHES[apiId] = {
                domaci, hoste, datum: match.utcDate, isPlayoff, kolo,
                vysledek_domaci: golyDomaci, vysledek_hoste: golyHoste,
                apiStatus: status, postup: postupVal
            };
        }

        if (dosloKStavoveZmene || obsahujeAktivniZapas) {
            console.log("⚡ Detekována herní aktivita nebo změna skóre. Přepočítávám RAM registry...");
            await rekonstruujAgregaty(dosloKStavoveZmene);
        }

        // ⏱️ DYNAMICKÝ MANAGMENT SPÁNKU
        if (obsahujeAktivniZapas) {
            setTimeout(providniApiHeartbeat, 60000); 
        } else {
            setTimeout(providniApiHeartbeat, 15 * 60 * 1000); 
        }

    } catch (err) {
        console.error("❌ Chyba v heartbeat smyčce, zkouším za minutu:", err);
        setTimeout(providniApiHeartbeat, 60000);
    }
}

// --- START DAEMONA ---
console.log("👑 TRVALÝ STAVOVÝ BACKEND BOT STARTUJE...");
inicializujLiveFirestoreStreams();
setTimeout(providniApiHeartbeat, 4000);
