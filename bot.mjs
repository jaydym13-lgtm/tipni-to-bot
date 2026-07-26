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
    "Chance Liga": { id: "345", provider: "API_SPORTS" },
    "MS ve fotbale": { id: "WC", provider: "FOOTBALL_DATA" },
    "Premier League": { id: "PL", provider: "FOOTBALL_DATA" },
    "Tipsport Extraliga": { id: "TEL", provider: "MANUAL" },
    "MS v hokeji": { id: "WM", provider: "MANUAL" }
};

// Seznam lig, které má bot v tomto běhu živě obsluhovat
const SEZNAM_LIG = (process.env.ACTIVE_LEAGUES || "Chance Liga,MS ve fotbale")
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
async function uploadToR2(leagueName, filename, jsonData) {
    try {
        const bodyText = JSON.stringify(jsonData, null, 2);
        const ligaKlic = String(leagueName).replace(/ /g, "_");
        const dynamicPath = `sezony/${SEZONA_ID}/${ligaKlic}/${filename}`;
        await r2Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: dynamicPath,
            Body: bodyText,
            ContentType: "application/json"
        }));
    } catch (err) {
        console.error(`❌ Chyba distribuce souboru ${filename} (${leagueName}) do R2:`, err);
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
          rekonstruujAgregatyVsechny();
          emitReadySignalGlobal("tips");
      }, (err) => console.error("❌ Kritický výpadek databázového streamu sezón:", err));

    console.log(`📡 Spouštím permanentní synchronizaci zápasů z Firestore pro ligy: ${SEZNAM_LIG.join(', ')}...`);
    
    SEZNAM_LIG.forEach(leagueName => {
        if (!RAM_CENTRAL_MATCHES[leagueName]) RAM_CENTRAL_MATCHES[leagueName] = {};

        db.collection("ligy").doc(leagueName).collection("zapasy").onSnapshot(snapshot => {
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
            rekonstruujAgregatyVsechny();
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

async function rekonstruujAgregatyProLigu(leagueName, forceWriteHistory = false) {
    const ligaKlic = String(leagueName).replace(/ /g, "_");
    const centralMatches = RAM_CENTRAL_MATCHES[leagueName] || {};

    if (!readySignalsGlobal.users || !readySignalsGlobal.matches || !readySignalsGlobal.tips) {
        console.log(`⏳ JISTIČ AGREGÁTU [${leagueName}]: Čekám na kompletní načtení Firestore streamů do RAM...`);
        return;
    }
    const leagueDoc = await db.collection("ligy").doc(leagueName).get().catch(() => null);
    const realLeagueData = leagueDoc && leagueDoc.exists ? leagueDoc.data() : null;

    const zebricekMapa = {};
    const mapaPrezdivek = {};

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
        zebricekMapa[p.email].vitezMs = uSoutezData.bonusy?.vitez || '–';
        zebricekMapa[p.email].nejStrelec = uSoutezData.bonusy?.strelec || '–';
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
                    if (parseInt(uTip.tip_domaci) === parseInt(zapas.vysledek_domaci) && parseInt(uTip.tip_hoste) === parseInt(zapas.vysledek_hoste)) zebricekMapa[em].presneVysledkyCount++;
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
                    if (parseInt(uTip.tip_domaci) === parseInt(vDomaci) && parseInt(uTip.tip_hoste) === parseInt(vHoste)) zebricekMapa[em].presneVysledkyCountLive++;
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
        top3Kola: top3Kola,
        top3PresneLive: top3PresneLive,
        top3KolaLive: top3KolaLive,
        top3AktualniKolo: top3AktualniKolo,
        aktivniKoloText: aktivniKolo,
        aktualizovano: timestampNow
    };

    await uploadToR2(leagueName, "leaderboard.json", leaderboardJson);

    const rozpisJson = { zapasyMapa: centralMatches, aktualizovano: timestampNow };
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

    try {
        const pulsRef = db.collection('ligy').doc(leagueName).collection('stav').doc('puls');
        await pulsRef.set({
            verzeRozpisu: admin.firestore.FieldValue.increment(1),
            verzeZebricku: admin.firestore.FieldValue.increment(1),
            aktualizovano: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`📡 PULS SYNC [${leagueName}]: Firestore puls úspěšně aktualizován.`);
    } catch (pulsErr) {
        console.error(`❌ Selhal zápis pulsu pro ${leagueName}:`, pulsErr);
    }
}

async function providniApiHeartbeat() {
    console.log(`[${new Date().toLocaleTimeString()}] ⏱️ Heartbeat kontrola sportovního API pro ligy: ${SEZNAM_LIG.join(', ')}...`);
    
    if (!RAM_BOT_CONFIG.active) {
        console.log("⛔ BOT MANUÁLNĚ VYPNUT: Ovládací panel hlásí force_stop. Spím a nezatěžuji API...");
        setTimeout(providniApiHeartbeat, RAM_BOT_CONFIG.waitInterval * 60 * 1000);
        return;
    }

    const apiSportsKey = process.env.API_FOOTBALL_KEY;
    const footballDataKey = process.env.FOOTBALL_DATA_API_KEY;

    let celkovyDosloKStavoveZmene = false;
    let celkovyObsahujeAktivniZapas = false;
    let minRozdilDoZapasu = Infinity;
    let pristiZapasIso = null;

    for (const leagueName of SEZNAM_LIG) {
        const leagueConfig = LIGY_API_MAPA[leagueName] || { id: "WC", provider: "MANUAL" };
        const provider = leagueConfig.provider;
        const leagueApiId = leagueConfig.id;

        if (provider === "MANUAL") {
            console.log(`ℹ️ Liga [${leagueName}] běží v čistém Firestore režimu (MANUAL).`);
            continue;
        }

        // 🧠 SMART SCHEDULER (DIETA API LIMITŮ): Kontrola, zda má ligu smysl dotazovat
        const centralneZapasyLigy = Object.values(RAM_CENTRAL_MATCHES[leagueName] || {});
        const maAktivniZapasVRam = centralneZapasyLigy.some(z => z.apiStatus === "IN_PLAY" || z.apiStatus === "PAUSED");
        const nyniMs = Date.now();
        const najblizsiZapasMs = centralneZapasyLigy
            .filter(z => z.apiStatus === "SCHEDULED" && Date.parse(z.datum) > nyniMs)
            .reduce((min, z) => Math.min(min, Date.parse(z.datum)), Infinity);

        const minutyDoDalsihoZapasu = (najblizsiZapasMs - nyniMs) / (1000 * 60);
        const maBudouciZapasBlizko = minutyDoDalsihoZapasu <= 120; // 2 hodiny do výkopu/buly nebo méně
        const maPrazdnouRam = centralneZapasyLigy.length === 0;

        // Pokud máme rozpis v RAM, nehrají se žádné živé zápasy a další zápas je daleko -> PŘESAKUJEME API
        if (!maPrazdnouRam && !maAktivniZapasVRam && !maBudouciZapasBlizko) {
            const hodinyDoZapasu = Math.round(minutyDoDalsihoZapasu / 60);
            const textCasu = isFinite(hodinyDoZapasu) ? `${hodinyDoZapasu} hod` : "nedohlednu";
            console.log(`💤 SMART SCHEDULER [${leagueName}]: Zápas v ${textCasu}. Šetřím API kredity a přesakuji dotaz.`);
            
            if (minutyDoDalsihoZapasu < minRozdilDoZapasu) {
                minRozdilDoZapasu = minutyDoDalsihoZapasu;
                pristiZapasIso = new Date(najblizsiZapasMs).toISOString();
            }
            continue;
        }

        try {
            let matches = [];

            if (provider === "API_SPORTS") {
                if (!apiSportsKey) {
                    console.log(`⚠️ Chybí API_FOOTBALL_KEY pro API-Sports [${leagueName}]. Přesakuji...`);
                    continue;
                }
                const seasonYear = new Date().getFullYear();
                const response = await fetch(`https://v3.football.api-sports.io/fixtures?league=${leagueApiId}&season=${seasonYear}`, {
                    headers: { "x-apisports-key": apiSportsKey }
                });
                if (!response.ok) throw new Error(`API-Sports error (${leagueName}): ${response.status}`);
                const apiData = await response.json();
                
                matches = (apiData.response || []).map(f => ({
                    id: String(f.fixture.id),
                    status: f.fixture.status.short === "FT" ? "FINISHED" : (["1H", "2H", "HT", "ET", "P"].includes(f.fixture.status.short) ? "IN_PLAY" : "SCHEDULED"),
                    utcDate: f.fixture.date,
                    homeTeam: { name: f.teams.home.name },
                    awayTeam: { name: f.teams.away.name },
                    stage: "REGULAR_SEASON",
                    matchday: f.league.round ? parseInt(f.league.round.replace(/[^0-9]/g, '')) || 1 : 1,
                    score: {
                        fullTime: { home: f.goals.home, away: f.goals.away },
                        winner: f.teams.home.winner ? "HOME_TEAM" : (f.teams.away.winner ? "AWAY_TEAM" : null)
                    }
                }));
            } else if (provider === "FOOTBALL_DATA") {
                if (!footballDataKey) {
                    console.log(`⚠️ Chybí FOOTBALL_DATA_API_KEY pro [${leagueName}]. Přesakuji...`);
                    continue;
                }
                const response = await fetch(`https://api.football-data.org/v4/competitions/${leagueApiId}/matches`, {
                    headers: { "X-Auth-Token": footballDataKey }
                });
                if (!response.ok) throw new Error(`Football-Data error (${leagueName}): ${response.status}`);
                const apiData = await response.json();
                matches = apiData.matches || [];
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

                const limitBudoucnostiMili = 28 * 24 * 60 * 60 * 1000;
                if (status === "SCHEDULED" && (startZapasuMilisekundy - nyniMilisekundy) > limitBudoucnostiMili) {
                    continue;
                }

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
                const isPlayoff = match.stage !== "GROUP_STAGE";

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

                if (status !== "FINISHED" && matchStarted && !PROCESSED_FREEZE_MATCHES.has(apiId)) {
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
                    PROCESSED_FREEZE_MATCHES.add(apiId);
                    celkovyDosloKStavoveZmene = true;
                }

                const stary = RAM_CENTRAL_MATCHES[leagueName] ? RAM_CENTRAL_MATCHES[leagueName][apiId] : null;
                if (!stary || stary.apiStatus !== status || stary.vysledek_domaci !== golyDomaci || stary.vysledek_hoste !== golyHoste || stary.postup !== postupVal) {
                    celkovyDosloKStavoveZmene = true;
                }

                const stage = match.stage || "";
                const jeToCtyrteKolo = stage === "LAST_32" || stage === "LAST_16" || stary?.kolo === "LAST_32" || stary?.kolo === "LAST_16" || stary?.kolo === "4. kolo";
                
                let spravneKoloTurnaje = "Šampionát";
                if (jeToCtyrteKolo) {
                    spravneKoloTurnaje = "4. kolo";
                } else if (isPlayoff) {
                    if (stage === "QUARTER_FINALS") spravneKoloTurnaje = "Čtvrtfinále";
                    else if (stage === "SEMI_FINALS") spravneKoloTurnaje = "Semifinále";
                    else if (stage === "THIRD_PLACE") spravneKoloTurnaje = "Zápas o 3. místo";
                    else if (stage === "FINAL") spravneKoloTurnaje = "Finále";
                    else spravneKoloTurnaje = "Play-off";
                } else if (match.matchday) {
                    spravneKoloTurnaje = `Kolo ${match.matchday}`;
                }

                const finalDomaci = (!stary || stary.domaci === "Neznámý") ? domaci : stary.domaci;
                const finalHoste = (!stary || stary.hoste === "Neznámý") ? hoste : stary.hoste;

                const detekovanNovyRozlosovanyTym = stary && (stary.domaci === "Neznámý" && domaci !== "Neznámý");
                const jeUkoncenBezVysledkuVDB = status === "FINISHED" && golyDomaci !== undefined && golyHoste !== undefined && (!stary || stary.vysledek_domaci === undefined);
                const potrebujeOpravitKoloVDB = stary && (stary.kolo !== spravneKoloTurnaje);

                if (detekovanNovyRozlosovanyTym || jeUkoncenBezVysledkuVDB || potrebujeOpravitKoloVDB) {
                    console.log(`💾 AUTO-SYNC FIREBASE [${leagueName}]: ${finalDomaci} - ${finalHoste} (${spravneKoloTurnaje})`);
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

                    db.collection("ligy").doc(leagueName).collection("zapasy").doc(apiId).set(syncPayload, { merge: true })
                        .catch(e => console.error(`❌ Chyba sync Firebase [${leagueName}]:`, e));
                }

                if (!RAM_CENTRAL_MATCHES[leagueName]) RAM_CENTRAL_MATCHES[leagueName] = {};
                RAM_CENTRAL_MATCHES[leagueName][apiId] = {
                    domaci: finalDomaci,
                    hoste: finalHoste,
                    datum: match.utcDate,
                    isPlayoff: stary?.isPlayoff !== undefined ? stary.isPlayoff : isPlayoff,
                    kolo: spravneKoloTurnaje,
                    stage: match.stage || stary?.stage || "",
                    vysledek_domaci: golyDomaci !== undefined ? golyDomaci : stary?.vysledek_domaci,
                    vysledek_hoste: golyHoste !== undefined ? golyHoste : stary?.vysledek_hoste,
                    apiStatus: status,
                    postup: postupVal || stary?.postup || ""
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

    if (celkovyDosloKStavoveZmene) {
        console.log("⚡ Detekována událost v ligách. Přepočítávám RAM a posílám R2 update...");
        await rekonstruujAgregatyVsechny(celkovyDosloKStavoveZmene);
    }

    const jeZapasV_OkneBojovehoRezimu = minRozdilDoZapasu <= 6;
    if (celkovyObsahujeAktivniZapas || jeZapasV_OkneBojovehoRezimu) {
        console.log(`🚀 STATUS: Zápasy aktivně běží nebo se blíží výkop.`);
    } else {
        console.log(`💤 STATUS: Klid zbraní. Nejbližší zápas je za ${Math.round(minRozdilDoZapasu)} min.`);
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
