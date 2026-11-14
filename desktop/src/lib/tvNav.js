'use strict';

/**
 * Fonctions du mode TV injectées dans les pages par toString() : elles sont
 * autonomes (aucune fermeture) et testées telles quelles sous Node.
 */

/**
 * Navigation spatiale : choisit l'élément le plus proche dans une direction,
 * à partir des rectangles à l'écran.
 *
 * @param {{left:number,top:number,right:number,bottom:number}|null} current
 * @param {Array<{left:number,top:number,right:number,bottom:number}>} candidates
 * @param {'up'|'down'|'left'|'right'} dir
 * @returns {number} index du candidat retenu, -1 si aucun
 */
function pickNext(current, candidates, dir) {
  if (!candidates || !candidates.length) return -1;
  if (!current) return 0;
  var cx = (current.left + current.right) / 2;
  var cy = (current.top + current.bottom) / 2;
  var best = -1;
  var bestScore = Infinity;
  for (var i = 0; i < candidates.length; i++) {
    var r = candidates[i];
    var x = (r.left + r.right) / 2;
    var y = (r.top + r.bottom) / 2;
    var primary;
    var cross;
    var overlap;
    if (dir === 'left' || dir === 'right') {
      primary = dir === 'right' ? r.left - current.right : current.left - r.right;
      if ((dir === 'right' ? x - cx : cx - x) <= 1) continue;
      cross = Math.abs(y - cy);
      overlap = Math.min(r.bottom, current.bottom) - Math.max(r.top, current.top);
    } else {
      primary = dir === 'down' ? r.top - current.bottom : current.top - r.bottom;
      if ((dir === 'down' ? y - cy : cy - y) <= 1) continue;
      cross = Math.abs(x - cx);
      overlap = Math.min(r.right, current.right) - Math.max(r.left, current.left);
    }
    if (primary < 0) primary = 0;
    // Un élément aligné (qui se recouvre sur l'axe transverse) passe avant un
    // élément plus proche mais décalé : c'est ce qui garde le curseur dans sa
    // rangée à gauche/droite et dans sa colonne en haut/bas.
    var score = primary + cross * (overlap > 0 ? 0.35 : 2.5) + (overlap > 0 ? 0 : 400);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Pilote la vidéo principale d'un document (page du site ou iframe d'un
 * lecteur externe). Fonction autonome, injectée par toString() comme pickNext.
 *
 * @param {Document} doc
 * @param {string} key  'ok' | 'playpause' | 'left' | 'right' | 'rewind' | 'forward' | 'up' | 'down' | 'volup' | 'voldown' | 'mute'
 * @returns {string} libellé à afficher à l'écran, '' si aucune vidéo chargée ou touche sans effet
 */
function controlVideo(doc, key) {
  var list = Array.prototype.slice.call(doc.querySelectorAll('video')).filter(function (v) { return v.readyState > 0; });
  if (!list.length) return '';
  list.sort(function (a, b) { return (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight); });
  var video = list[0];
  function seek(delta) {
    var end = isFinite(video.duration) && video.duration > 1 ? video.duration - 1 : Infinity;
    try {
      video.currentTime = Math.max(0, Math.min(end, video.currentTime + delta));
    } catch (e) {
      return '';
    }
    return (delta > 0 ? '+' : '−') + Math.abs(delta) + ' s';
  }
  function volume(delta) {
    video.muted = false;
    video.volume = Math.max(0, Math.min(1, Math.round((video.volume + delta) * 10) / 10));
    return 'Volume ' + Math.round(video.volume * 100) + ' %';
  }
  if (key === 'ok' || key === 'playpause') {
    if (!video.paused) {
      video.pause();
      return '⏸ Pause';
    }
    var started = video.play();
    if (started && started.catch) started.catch(function () {});
    return '▶ Lecture';
  }
  if (key === 'left') return seek(-10);
  if (key === 'right') return seek(10);
  if (key === 'rewind') return seek(-30);
  if (key === 'forward') return seek(30);
  if (key === 'up' || key === 'volup') return volume(0.1);
  if (key === 'down' || key === 'voldown') return volume(-0.1);
  if (key === 'mute') {
    video.muted = !video.muted;
    return video.muted ? 'Son coupé' : 'Son rétabli';
  }
  return '';
}

module.exports = { pickNext, controlVideo };
