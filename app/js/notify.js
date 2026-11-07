/* notify.js — App.notify: avisos push al móvil con ntfy.sh.
 * App.notify.send(title, body): si hay ajuste `ntfyTopic`, POST a https://ntfy.sh/<topic>. Sin topic no hace nada.
 * Registra sus ajustes (grupo "settings.group.notify") y sus textos i18n.
 */
(function(){
"use strict";

var App = window.App;

App.settings.define("ntfyTopic", "");
App.settings.define("followAuto", false);
App.settings.define("syncUrl", "");
App.settings.define("stremioAddons", []);
App.settings.define("liveExtraLists", []);

App.i18n.add("en", {
  "settings.group.notify": "Notifications",
  "notify.topic": "ntfy topic",
  "notify.topicDesc": "Install the ntfy app on your phone and subscribe to this topic. Pick something hard to guess.",
  "notify.test": "Send test notification",
  "notify.testTitle": "TorBox TV",
  "notify.testBody": "Test notification: it works!",
  "notify.testOk": "Notification sent",
  "notify.testFail": "Could not send the notification",
  "notify.noTopic": "Set a ntfy topic first",
  "notify.notSet": "Not set"
});
App.i18n.add("es", {
  "settings.group.notify": "Notificaciones",
  "notify.topic": "Tema de ntfy",
  "notify.topicDesc": "Instala la app ntfy en el móvil y suscríbete a este tema. Elige algo difícil de adivinar.",
  "notify.test": "Enviar notificación de prueba",
  "notify.testTitle": "TorBox TV",
  "notify.testBody": "Notificación de prueba: ¡funciona!",
  "notify.testOk": "Notificación enviada",
  "notify.testFail": "No se pudo enviar la notificación",
  "notify.noTopic": "Primero configura un tema de ntfy",
  "notify.notSet": "Sin configurar"
});
App.i18n.add("ca", {
  "settings.group.notify": "Notificacions",
  "notify.topic": "Tema de ntfy",
  "notify.topicDesc": "Instal·la l'app ntfy al mòbil i subscriu-te a aquest tema. Tria alguna cosa difícil d'endevinar.",
  "notify.test": "Envia una notificació de prova",
  "notify.testTitle": "TorBox TV",
  "notify.testBody": "Notificació de prova: funciona!",
  "notify.testOk": "Notificació enviada",
  "notify.testFail": "No s'ha pogut enviar la notificació",
  "notify.noTopic": "Primer configura un tema de ntfy",
  "notify.notSet": "Sense configurar"
});
App.i18n.add("gl", {
  "settings.group.notify": "Notificacións",
  "notify.topic": "Tema de ntfy",
  "notify.topicDesc": "Instala a app ntfy no móbil e subscríbete a este tema. Escolle algo difícil de adiviñar.",
  "notify.test": "Enviar notificación de proba",
  "notify.testTitle": "TorBox TV",
  "notify.testBody": "Notificación de proba: funciona!",
  "notify.testOk": "Notificación enviada",
  "notify.testFail": "Non se puido enviar a notificación",
  "notify.noTopic": "Primeiro configura un tema de ntfy",
  "notify.notSet": "Sen configurar"
});
App.i18n.add("eu", {
  "settings.group.notify": "Jakinarazpenak",
  "notify.topic": "ntfy gaia",
  "notify.topicDesc": "Instalatu ntfy aplikazioa telefonoan eta harpidetu gai honetara. Aukeratu asmatzen zaila den zerbait.",
  "notify.test": "Bidali probako jakinarazpena",
  "notify.testTitle": "TorBox TV",
  "notify.testBody": "Probako jakinarazpena: badabil!",
  "notify.testOk": "Jakinarazpena bidali da",
  "notify.testFail": "Ezin izan da jakinarazpena bidali",
  "notify.noTopic": "Konfiguratu lehenik ntfy gai bat",
  "notify.notSet": "Konfiguratu gabe"
});
App.i18n.add("pt", {
  "settings.group.notify": "Notificações",
  "notify.topic": "Tópico do ntfy",
  "notify.topicDesc": "Instale a aplicação ntfy no telemóvel e subscreva este tópico. Escolha algo difícil de adivinhar.",
  "notify.test": "Enviar notificação de teste",
  "notify.testTitle": "TorBox TV",
  "notify.testBody": "Notificação de teste: funciona!",
  "notify.testOk": "Notificação enviada",
  "notify.testFail": "Não foi possível enviar a notificação",
  "notify.noTopic": "Configure primeiro um tópico do ntfy",
  "notify.notSet": "Não configurado"
});
App.i18n.add("fr", {
  "settings.group.notify": "Notifications",
  "notify.topic": "Sujet ntfy",
  "notify.topicDesc": "Installez l'application ntfy sur votre téléphone et abonnez-vous à ce sujet. Choisissez quelque chose de difficile à deviner.",
  "notify.test": "Envoyer une notification de test",
  "notify.testTitle": "TorBox TV",
  "notify.testBody": "Notification de test : ça marche !",
  "notify.testOk": "Notification envoyée",
  "notify.testFail": "Impossible d'envoyer la notification",
  "notify.noTopic": "Configurez d'abord un sujet ntfy",
  "notify.notSet": "Non configuré"
});

function topic(){
  return String(App.settings.get("ntfyTopic") || "").trim().replace(/[^A-Za-z0-9_-]/g, "");
}

/* Cabeceras HTTP solo admiten Latin-1: el título viaja en el JSON (publicación JSON a la raíz de ntfy) */
App.notify = {
  topic: topic,
  send: function(title, body){
    var tp = topic();
    if(!tp) return Promise.resolve(false);
    var payload = { topic: tp, title: String(title || "TorBox"), message: String(body || ""), tags: ["tv"] };
    var f = (App.net && App.net.fetch) ? App.net.fetch : fetch;
    return f("https://ntfy.sh/", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    }).then(function(r){
      if(!r.ok) throw new Error("HTTP " + r.status);
      return true;
    }).catch(function(e){
      console.warn("[notify] " + (e && e.message));
      return false;
    });
  },
  test: function(){
    if(!topic()){ App.ui.toast(App.t("notify.noTopic")); return Promise.resolve(false); }
    return App.notify.send(App.t("notify.testTitle"), App.t("notify.testBody")).then(function(ok){
      App.ui.toast(App.t(ok ? "notify.testOk" : "notify.testFail"));
      return ok;
    });
  }
};

App.settingsUI.add("settings.group.notify", {
  id: "ntfyTopic", type: "text",
  label: function(){ return App.t("notify.topic"); },
  desc: function(){ return App.t("notify.topicDesc"); },
  value: function(){ return App.settings.get("ntfyTopic") || App.t("notify.notSet"); }
});
App.settingsUI.add("settings.group.notify", {
  id: "ntfyTest", type: "action",
  label: function(){ return App.t("notify.test"); },
  run: function(){ App.notify.test(); }
});

})();
