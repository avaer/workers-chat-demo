import {makeId, zstringify} from './util.mjs';
// import {zstringify} from './encoding.mjs';
import {frameSize, realmSize} from './constants.js';

import {RemotePlayerCursorHtmlRenderer, AppsHtmlRenderer, GameRealmsCanvases, GamePlayerCanvas} from "./renderers/html-renderer.js";
import {NetworkRealms} from "./network-realms.js";

//

// XXX wait for sync before we finally disconnect, or else the message might not have been sent befor we disconnect

//

// throttle a function every ms, queueing
const _throttleFn = (fn, ms) => {
  let running = false;
  let queued = false;
  let timeout;
  return (...args) => {
    if (!running) {
      running = true;
      fn(...args);
      timeout = setTimeout(() => {
        running = false;
        if (queued) {
          queued = false;
          fn(...args);
        }
      }, ms);
    } else {
      queued = true;
    }
  };
};
const _updateCoord = _throttleFn((coord) => {
  const u = new URL(window.location.href);
  u.searchParams.set('coord', JSON.stringify(coord));
  history.replaceState({}, '', u);
}, 500);

//

export const startGame = async ({
  initialCoord = [0, 0, 0],
} = {}) => {
  const playerId = makeId();
  let localPlayerCanvas = null;
  
  // console.log('got initial coord', initialCoord);

  // realms
  const realms = new NetworkRealms(playerId);
  // globalThis.realms = realms; // XXX for testing
  const realmCleanupFns = new Map();
  realms.addEventListener('realmconnecting', e => {
    const {realm} = e.data;
    const el = Array.from(realmsCanvases.element.childNodes).find(el => {
      return el.min[0] === realm.min[0] && el.min[2] === realm.min[2];
    });
    if (el) {
      el.classList.add('connecting');
    }
  });
  const getRealmElement = realm => Array.from(realmsCanvases.element.childNodes).find(el => {
    return el.min[0] === realm.min[0] && el.min[2] === realm.min[2];
  });

  const onentityadd2 = e => {
    // const {entity} = e.data;
    // console.log('world app entity add', e.data);
  };
  realms.getVirtualWorld().worldApps.addEventListener('needledentityadd', onentityadd2);
  const onentityremove2 = e => {
    // console.log('world app entity remove', e.data);
  };
  realms.getVirtualWorld().worldApps.addEventListener('entityremove', onentityremove2);

  realms.addEventListener('realmjoin', e => {
    const {realm} = e.data;
    const el = getRealmElement(realm);
    if (el) {
      el.classList.add('connected');
      el.classList.remove('connecting');

      const {dataClient} = realm;

      el.updateText(dataClient);

      const playersArray = dataClient.getArray('players');
      // const worldApps = dataClient.getArray('worldApps');
      
      const onadd = e => {
        // console.log('game players array add', realm.key, e.data, playersArray.toArray());
        const {map: playerMap} = e.data;

        playerMap.listen();
        playerMap.addEventListener('update', e => {
          // console.log('player map update', e.data);

          el.updateText(dataClient);
        });

        el.updateText(dataClient);
      };
      playersArray.addEventListener('add', onadd);

      // console.log('game players array listen on realm', realm.key);
      const onremove = e => {
        // console.log('game players array remove', realm.key, e.data, playersArray.toArray());
        const {map: playerMap} = e.data;

        el.updateText(dataClient);
      };
      playersArray.addEventListener('remove', onremove);

      const onentityadd3 = e => {
        // const {entity} = e.data;
        el.updateText(dataClient);
      };
      virtualWorld.worldApps.addEventListener('needledentityadd', onentityadd3);

      const onentityremove3 = e => {
        // const {entity} = e.data;
        el.updateText(dataClient);
      };
      virtualWorld.worldApps.addEventListener('needledentityremove', onentityremove3);
  
      realmCleanupFns.set(realm, () => {
        dataClient.removeEventListener('add', onadd);
        dataClient.removeEventListener('remove', onremove);
        virtualWorld.worldApps.removeEventListener('needledentityadd', onentityadd3);
        virtualWorld.worldApps.removeEventListener('needledentityremove', onentityremove3);

        playersArray.unlisten();

        // console.log('game players array cancel on realm', realm.key);
      });
    }
  });
  realms.addEventListener('realmleave', e => {
    const {realm} = e.data;
    const el = Array.from(realmsCanvases.element.childNodes).find(el => {
      return el.min[0] === realm.min[0] && el.min[2] === realm.min[2];
    });
    if (el) {
      el.classList.remove('connected');
      el.classList.remove('connecting');

      realmCleanupFns.get(realm)();
      realmCleanupFns.delete(realm);
    }
  });

  const gameEl = document.getElementById('game');
  
  // realms canvas
  const realmsCanvases = new GameRealmsCanvases(realms);
  gameEl.appendChild(realmsCanvases.element);

  // local objects
  const virtualWorld = realms.getVirtualWorld();
  const virtualPlayers = realms.getVirtualPlayers();

  const _initLogic = () => {
    // world
    // const worldItemRenderers = [];
    // bind

    // local player
    const localPlayerCursorRenderer = new RemotePlayerCursorHtmlRenderer(realms.playerId, realms.playerId, realms.localPlayer);
    const appsRenderer = new AppsHtmlRenderer(realms);

    const _addPlayer = player => {
      // ui
      let p = document.createElement("p");
      p.classList.add('player');
      p.innerHTML = `<img src="/public/images/audio.svg" class="audio-icon"><span class="name">${player.arrayIndexId}</span>`;
      roster.appendChild(p);

      // render
      const playerCursorRenderer = new RemotePlayerCursorHtmlRenderer(player.arrayIndexId, playerId, player);
      playerCursorRenderers.push(playerCursorRenderer);
    };
    const _removePlayer = playerId => {
      for (let i = 0; i < roster.children.length; i++) {
        let p = roster.children[i];
        if (p.innerText === playerId) {
          roster.removeChild(p);
          break;
        }
      }

      for (let i = 0; i < playerCursorRenderers.length; i++) {
        const playerCursorRenderer = playerCursorRenderers[i];
        if (playerCursorRenderer.remotePlayerId === playerId) {
          playerCursorRenderers.splice(i, 1);
          playerCursorRenderer.destroy();
          break;
        }
      }
    };

    // players
    const playerCursorRenderers = [];
    virtualPlayers.addEventListener('join', e => {
      // console.log('add virtual player', e.data);
      const {player} = e.data;
      _addPlayer(player);
    });
    virtualPlayers.addEventListener('leave', e => {
      // console.log('remove virtual player', e.data);
      const {playerId} = e.data;
      _removePlayer(playerId);
    });
    _addPlayer(realms.localPlayer);
    
    // audio
    const _enableAudioOutput = playerId => {
      for (let i = 0; i < roster.children.length; i++) {
        let p = roster.children[i];
        const textNode = p.children[1];
        if (textNode.innerText === playerId) {
          // console.log('swap on');
          p.classList.add('speaking');
          break;
        }
      }
    };
    const _disableAudioOutput = playerId => {
      for (let i = 0; i < roster.children.length; i++) {
        let p = roster.children[i];
        const textNode = p.children[1];
        if (textNode.innerText === playerId) {
          // console.log('swap off');
          p.classList.remove('speaking');
          break;
        }
      }
    };
    realms.addEventListener('audiostreamstart', e => {
      const {playerId} = e.data;
      // console.log('stream start', playerId);
      _enableAudioOutput(playerId);
    });
    realms.addEventListener('audiostreamend', e => {
      const {playerId} = e.data;
      // console.log('stream end', playerId);
      _disableAudioOutput(playerId);
    });

    // wait for the network to be ready befor binding controls
    realms.addEventListener('networkreconfigure', e => {
      const _bindControls = () => {
        const mousemove = e => {
          realms.localPlayer.setKeyValue('cursorPosition', Float32Array.from([e.clientX, e.clientY, 0]));
        };
        window.addEventListener('mousemove', mousemove);
      };
      _bindControls();
    }, {once: true});
  };
  _initLogic();

  const _initRenderers = () => {
    GamePlayerCanvas.waitForLoad(); // note: not actually waiting

    // players wrapper element
    const playersEl = document.createElement('div');
    playersEl.id = 'players';
    playersEl.classList.add('players');
    gameEl.appendChild(playersEl);

    // local player rendering
    localPlayerCanvas = new GamePlayerCanvas(realms.localPlayer, {
      // initialCoord,
    });
    let localPlayerFocused = false;
    localPlayerCanvas.element.addEventListener('focus', e => {
      // console.log('character focus 1');
      localPlayerFocused = true;
    });
    localPlayerCanvas.element.addEventListener('blur', e => {
      // console.log('character blur 1');
      localPlayerFocused = false;
    });
    window.addEventListener('keydown', e => {
      if (localPlayerFocused) {
        // WASD
        switch (e.code) {
          case 'KeyW': {
            localPlayerCanvas.velocity[2] = -1;
            break;
          }
          case 'KeyA': {
            localPlayerCanvas.velocity[0] = -1;
            break;
          }
          case 'KeyS': {
            localPlayerCanvas.velocity[2] = 1;
            break;
          }
          case 'KeyD': {
            localPlayerCanvas.velocity[0] = 1;
            break;
          }
          case 'KeyE': {
            _pickupDrop();
            break;
          }
        }
      }
    });
    window.addEventListener('keyup', e => {
      switch (e.code) {
        case 'KeyW': {
          localPlayerCanvas.velocity[2] = 0;
          break;
        }
        case 'KeyA': {
          localPlayerCanvas.velocity[0] = 0;
          break;
        }
        case 'KeyS': {
          localPlayerCanvas.velocity[2] = 0;
          break;
        }
        case 'KeyD': {
          localPlayerCanvas.velocity[0] = 0;
          break;
        }
      }
    });
    localPlayerCanvas.element.focus();
    document.body.addEventListener('click', e => {
      localPlayerCanvas.element.focus();
    });
    playersEl.appendChild(localPlayerCanvas.element);

    // remote players rendering
    const remotePlayerCanvases = new Map();
    realms.players.addEventListener('join', e => {
      const {playerId, player} = e.data;
      console.log('join', e.data);

      if (playerId !== realms.playerId) {
        const remotePlayer = player;
        const remotePlayerCanvas = new GamePlayerCanvas(remotePlayer, {
          // initialCoord,
        });
        playersEl.appendChild(remotePlayerCanvas.element);
        remotePlayerCanvases.set(playerId, remotePlayerCanvas);
      }
    });
    realms.players.addEventListener('leave', e => {
      const {playerId} = e.data;
      console.log('leave', e.data);

      if (playerId !== realms.playerId) {
        const remotePlayerCanvas = remotePlayerCanvases.get(playerId);
        remotePlayerCanvas.element.parent.removeChild(remotePlayerCanvas.element);
        remotePlayerCanvas.destroy();
        remotePlayerCanvases.delete(playerId);
      }
    });

    // action methods
    const _pickupDrop = () => {
      // console.log('drop 1');
      const position = localPlayerCanvas.virtualPlayer.getKey('position');
      const direction = localPlayerCanvas.virtualPlayer.getKey('direction');
      const targetPosition = [
        position[0] + direction[0] * frameSize,
        0,
        position[2] + direction[2] * frameSize - frameSize / 2,
      ];
      const targetBox = {
        min: [
          targetPosition[0] - frameSize / 2,
          0,
          targetPosition[2] - frameSize / 2,
        ],
        max: [
          targetPosition[0] + frameSize / 2,
          0,
          targetPosition[2] + frameSize / 2,
        ],
      };
      const _boxContains = (box, position) => {
        return position[0] >= box.min[0] && position[0] <= box.max[0] &&
          position[1] >= box.min[1] && position[1] <= box.max[1] &&
          position[2] >= box.min[2] && position[2] <= box.max[2];
      };
      const _needledEntityIsWorn = needledEntity => {
        const actions = realms.localPlayer.playerActions.toArray();
        const action = actions.find(action => action.action === 'wear' && action.appId === needledEntity.entityMap.arrayIndexId);
        return !!action;
      };
      const _getCollision = () => {
        return Array.from(virtualWorld.worldApps.needledVirtualEntities.values()).find(needledEntityMap => {
          const worn = _needledEntityIsWorn(needledEntityMap);
          if (!worn) {
            const position = needledEntityMap.get('position');
            return !!position && _boxContains(targetBox, position);
          } else {
            return false;
          }
        });
      };
      
      const collidedVirtualMap = _getCollision();
      if (collidedVirtualMap) {
        // deadhand
        const sourceRealm = collidedVirtualMap.headTracker.getHeadRealm();
        const deadHandUpdate = sourceRealm.dataClient.deadHandArrayMaps(
          realms.localPlayer.playerApps.arrayId,
          [collidedVirtualMap.entityMap.arrayIndexId],
          realms.playerId,
        );
        sourceRealm.emitUpdate(deadHandUpdate);
        
        // track
        // collidedVirtualMap.setHeadTracker(realms.localPlayer.playerApps.headTracker);

        // add app to the new location (player)
        const collidedAppJson = collidedVirtualMap.toObject();
        const targetRealm = realms.localPlayer.headTracker.getHeadRealm();
        const newAppMap = realms.localPlayer.playerApps.addEntityAt(
          collidedVirtualMap.entityMap.arrayIndexId,
          collidedAppJson,
          targetRealm
        );

        // XXX collidedVirtualMap needs to get the new headTracker
        if (!realms.localPlayer.headTracker) {
          debugger;
        }

        // add new action
        const action = {
          position: targetPosition,
          action: 'wear',
          appId: collidedVirtualMap.entityMap.arrayIndexId,
        };
        const newActionMap = realms.localPlayer.playerActions.addEntity(action, targetRealm);

        // remove from the old location (world)
        collidedVirtualMap.remove();

        // livehand
        const liveHandUpdate = targetRealm.dataClient.liveHandArrayMaps(
          realms.localPlayer.playerApps.arrayId,
          [collidedVirtualMap.entityMap.arrayIndexId],
          realms.playerId,
        );
        sourceRealm.emitUpdate(liveHandUpdate);
      } else {
        // console.log('got player apps', realms.localPlayer.playerApps.getSize());
        if (realms.localPlayer.playerActions.getSize() > 0) {
          const targetRealm = realms.getClosestRealm(targetPosition);
          if (targetRealm) {
            // console.log('drop to target realm', targetRealm.key, targetRealm);

            // the app we will be dropping
            const actions = realms.localPlayer.playerActions.toArray();
            const wearActionIndex = actions.findIndex(action => action.action === 'wear');
            const wearAction = actions[wearActionIndex];
            const {appId} = wearAction;

            const appIds = realms.localPlayer.playerApps.getKeys();
            const wearAppIndex = appIds.indexOf(appId);

            const firstAction = realms.localPlayer.playerActions.getVirtualMapAt(wearActionIndex);
            const firstApp = realms.localPlayer.playerApps.getVirtualMapAt(wearAppIndex);

            // const newHeadTracker = new HeadTracker('drop');
            // newHeadTracker.setHeadRealm(firstApp.headTracker.getHeadRealm());
            // newHeadTracker.setConnectedRealms(firstApp.headTracker.getConnectedRealms());
            // firstApp.setHeadTracker(newHeadTracker);

            // firstApp.set('position', targetPosition);

            // set dead hands
            // old location: player
            // the player already has deadhand on all of its apps, probably?
            // const deadHandUpdate = firstApp.headRealm.dataClient.deadHandArrayMaps(
            //   realms.localPlayer.playerApps.arrayId,
            //   [firstApp.entityMap.arrayIndexId],
            //   realms.playerId,
            // );
            // firstApp.headRealm.emitUpdate(deadHandUpdate);
            // new location: world
            const deadHandUpdate = targetRealm.dataClient.deadHandArrayMaps(
              'worldApps',
              [firstApp.entityMap.arrayIndexId],
              realms.playerId,
            );
            targetRealm.emitUpdate(deadHandUpdate);

            // add at the new location (world)
            const firstAppJson = firstApp.toObject();
            firstAppJson.position = targetPosition;
            const newPlayerAppMap = virtualWorld.worldApps.addEntityAt(
              firstApp.entityMap.arrayIndexId,
              firstAppJson,
              targetRealm
            );
            // const newPlayerApp = virtualWorld.worldApps.getVirtualMap(newPlayerAppMap.arrayIndexId);
            // newPlayerApp.headTracker.setHeadRealm(targetRealm);

            // remove from the old location (player)
            firstApp.remove();
            firstAction.remove();

            const liveHandUpdate = targetRealm.dataClient.liveHandArrayMap(
              'worldApps',
              [firstApp.entityMap.arrayIndexId],
              realms.playerId,
            );
            targetRealm.emitUpdate(liveHandUpdate);

          } else {
            console.warn('no containing realm to drop to');
          }
        } else {
          console.warn('nothing to drop');
        }
      }
    };
  };
  _initRenderers();

  const _startFrameLoop = () => {
    let connected = false;
    const onConnect = (position) => {
      console.log('on connect');
      if (!position) {
        debugger;
      }
      const appVals = [
        {
          start_url: 'rock',
          position: new Float32Array(3),
        },
        {
          start_url: 'rock',
          position: new Float32Array(3),
        }
      ];
      const appIds = Array(appVals.length);
      for (let i = 0; i < appIds.length; i++) {
        appIds[i] = makeId();
      }

      const actionVals = [
        {
          action: 'wear',
          appId: appIds[0],
        },
        {
          action: 'wear',
          appId: appIds[1],
        },
      ];

      const o = {
        position: position.slice(),
        direction: [0, 0, 1],
        cursorPosition: new Float32Array(3),
        name: 'Hanna',
      };
      // console.log('initialize player', o);
      realms.localPlayer.initializePlayer(o, {
        appVals,
        appIds,
        actionVals,
      });

      connected = true;
    };
    const _setInitialCoord = () => {
      // console.log('set initial coord', initialCoord);
      const initialPosition = [
        initialCoord[0],
        0,
        initialCoord[1],
      ];
      realms.updatePosition(initialPosition, realmSize, {
        onConnect,
      });
    };
    _setInitialCoord();

    let frame;
    const _recurse = () => {
      frame = requestAnimationFrame(_recurse);
      
      if (connected) {
        // move the local player
        localPlayerCanvas.move();
        
        // update realms set
        const position = realms.localPlayer.getKey('position');
        realms.updatePosition(position, realmSize, {
          // onConnect,
        });

        // draw the world
        const worldAppsEl = document.getElementById('world-apps');
        const networkRealmsEl = document.getElementById('network-realms');
        const cssText = `\
          transform: translate3d(${-position[0]}px, ${-position[2]}px, 0px);
        `;
        worldAppsEl.style.cssText = cssText;
        networkRealmsEl.style.cssText = cssText;

        // latch last coord
        const coord = [
          position[0],
          position[2],
        ];
        _updateCoord(coord);
      }
    };
    _recurse();
  };
  _startFrameLoop();

  return realms;
};