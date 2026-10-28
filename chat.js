import { firebaseConfig } from "./firebase-config.js";
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  initializeAuth,
  onAuthStateChanged,
  signInWithCredential
} from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from "firebase/firestore";
import { initializeApp } from "firebase/app";

const hasFirebaseConfig = ["apiKey", "authDomain", "projectId", "appId"]
  .every(key => typeof firebaseConfig[key] === "string" && firebaseConfig[key].trim());
let auth;
let database;
let currentUser = null;
let currentProfile = null;
let currentConversation = null;
let currentFriendList = [];
let stopConnections = null;
let stopRequests = null;
let stopMessages = null;
let callSubscriptions = new Map();
let activeCall = null;

const rtcConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

function toast(message) {
  const event = new CustomEvent("arcade:chat-toast", { detail: message });
  window.dispatchEvent(event);
}

function profileChanged(profile) {
  window.dispatchEvent(new CustomEvent("arcade:chat-profile", { detail: profile }));
}

function showUsernameDialog() {
  const dialog = document.getElementById("username-dialog");
  if (!dialog.open) dialog.showModal();
  document.getElementById("username-input").focus();
}

function stopListeners() {
  if (stopConnections) stopConnections();
  if (stopRequests) stopRequests();
  if (stopMessages) stopMessages();
  for (const stopCallSubscription of callSubscriptions.values()) stopCallSubscription();
  callSubscriptions.clear();
  if (activeCall) finishAudioCall(false);
  stopConnections = null;
  stopRequests = null;
  stopMessages = null;
  currentConversation = null;
  updateCallUi("idle");
}

function updateCallUi(state, detail = "") {
  const status = document.getElementById("chat-call-status");
  const startButton = document.getElementById("start-audio-call");
  const muteButton = document.getElementById("toggle-call-mute");
  const endButton = document.getElementById("end-audio-call");
  if (status) {
    const labels = {
      idle: "Личные сообщения",
      calling: `Звоним: ${detail}`,
      incoming: `${detail} звонит`,
      connecting: `Соединение: ${detail}`,
      active: `Разговор: ${detail}`
    };
    status.textContent = labels[state] || "Личные сообщения";
  }
  if (startButton) startButton.disabled = state !== "idle" || !currentConversation || Boolean(activeCall);
  if (muteButton) muteButton.hidden = state !== "active";
  if (endButton) endButton.hidden = !["calling", "connecting", "active"].includes(state);
  window.dispatchEvent(new CustomEvent("arcade:call-state", {
    detail: { state, detail }
  }));
}

function handleCallError(context, error) {
  console.error(context, error);
  toast(error.message || "Не удалось выполнить аудиозвонок.");
}

function stopCallPeerConnection(call) {
  if (call.stopCallDocument) call.stopCallDocument();
  if (call.stopRemoteCandidates) call.stopRemoteCandidates();
  if (call.stopLocalCandidates) call.stopLocalCandidates();
  clearTimeout(call.ringTimeout);
  if (call.peerConnection) {
    call.peerConnection.onicecandidate = null;
    call.peerConnection.ontrack = null;
    call.peerConnection.close();
  }
  if (call.localStream) {
    for (const track of call.localStream.getTracks()) track.stop();
  }
  const remoteAudio = document.getElementById("call-remote-audio");
  remoteAudio.srcObject = null;
  const muteButton = document.getElementById("toggle-call-mute");
  muteButton.textContent = "Выключить микрофон";
}

function finishAudioCall(updateRemote = true, status = "ended") {
  const call = activeCall;
  if (!call) return;
  activeCall = null;
  stopCallPeerConnection(call);
  document.getElementById("incoming-call-dialog").close();
  if (updateRemote && call.created && call.status !== "ended" && call.status !== "rejected" && call.status !== "cancelled") {
    updateDoc(call.reference, { status }).catch(error => handleCallError("Could not end audio call:", error));
  }
  updateCallUi("idle");
}

async function prepareCallPeerConnection(call) {
  const localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  if (activeCall !== call) {
    for (const track of localStream.getTracks()) track.stop();
    throw new Error("Звонок уже завершён.");
  }
  const peerConnection = new RTCPeerConnection(rtcConfiguration);
  call.localStream = localStream;
  call.peerConnection = peerConnection;
  for (const track of localStream.getTracks()) peerConnection.addTrack(track, localStream);
  peerConnection.ontrack = event => {
    const [remoteStream] = event.streams;
    if (!remoteStream) return;
    const remoteAudio = document.getElementById("call-remote-audio");
    remoteAudio.srcObject = remoteStream;
    remoteAudio.play().catch(error => handleCallError("Could not play incoming audio:", error));
  };
  peerConnection.onconnectionstatechange = () => {
    if (activeCall !== call) return;
    if (peerConnection.connectionState === "connected") {
      updateCallUi("active", call.friend.username);
    } else if (peerConnection.connectionState === "failed") {
      toast("Не удалось соединить звонок. Проверьте подключение к интернету и повторите попытку.");
      finishAudioCall(true);
    }
  };
  return peerConnection;
}

async function applyPendingCandidates(call) {
  if (!call.peerConnection?.remoteDescription) return;
  for (const candidate of call.pendingCandidates.splice(0)) {
    await call.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

function listenForRemoteCandidates(call, collectionName) {
  const candidates = collection(database, "conversations", call.conversationId, "calls", call.id, collectionName);
  const stop = onSnapshot(candidates, snapshot => {
    for (const candidateSnapshot of snapshot.docChanges()) {
      if (candidateSnapshot.type !== "added") continue;
      const candidate = candidateSnapshot.doc.data();
      if (!call.peerConnection?.remoteDescription) {
        call.pendingCandidates.push(candidate);
        continue;
      }
      call.peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
        .catch(error => handleCallError("Could not add remote ICE candidate:", error));
    }
  }, error => handleCallError("Audio call candidate subscription failed:", error));
  if (collectionName === "callerCandidates") call.stopRemoteCandidates = stop;
  else call.stopLocalCandidates = stop;
}

function watchCallDocument(call) {
  call.stopCallDocument = onSnapshot(call.reference, async snapshot => {
    if (!snapshot.exists() || activeCall !== call) return;
    const data = snapshot.data();
    call.status = data.status;
    if (["ended", "rejected", "cancelled"].includes(data.status)) {
      const message = data.status === "rejected"
        ? `${call.friend.username} отклонил звонок.`
        : data.status === "cancelled"
          ? "Звонок отменён."
          : "Звонок завершён.";
      finishAudioCall(false);
      toast(message);
      return;
    }
    if (call.role === "caller" && data.answer && !call.peerConnection.remoteDescription) {
      try {
        await call.peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        await applyPendingCandidates(call);
        if (activeCall !== call) return;
      } catch (error) {
        handleCallError("Could not apply audio call answer:", error);
        finishAudioCall(true);
      }
    }
    if (data.status === "accepted" && call.role === "caller") {
      clearTimeout(call.ringTimeout);
      updateCallUi("connecting", call.friend.username);
    }
  }, error => handleCallError("Audio call subscription failed:", error));
}

async function startAudioCall(friend) {
  if (!currentUser || !currentConversation || currentConversation.friend.uid !== friend.uid) {
    throw new Error("Сначала открой переписку с этим другом.");
  }
  if (activeCall) throw new Error("Сначала заверши текущий звонок.");
  if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
    throw new Error("Аудиозвонки не поддерживаются в этой среде.");
  }

  const reference = doc(collection(database, "conversations", currentConversation.id, "calls"));
  const call = {
    id: reference.id,
    reference,
    conversationId: currentConversation.id,
    friend,
    role: "caller",
    status: "preparing",
    created: false,
    localStream: null,
    peerConnection: null,
    stopCallDocument: null,
    stopRemoteCandidates: null,
    stopLocalCandidates: null,
    pendingCandidates: []
  };
  activeCall = call;
  updateCallUi("calling", friend.username);
  try {
    await setDoc(reference, {
      callerId: currentUser.uid,
      calleeId: friend.uid,
      status: "preparing",
      createdAt: serverTimestamp()
    });
    call.created = true;
    if (activeCall !== call) {
      await updateDoc(reference, { status: "cancelled" })
        .catch(error => handleCallError("Could not cancel a pending audio call:", error));
      return;
    }
    const peerConnection = await prepareCallPeerConnection(call);
    if (activeCall !== call) return;
    peerConnection.onicecandidate = event => {
      if (!event.candidate || activeCall !== call) return;
      addDoc(collection(database, "conversations", call.conversationId, "calls", call.id, "callerCandidates"), event.candidate.toJSON())
        .catch(error => handleCallError("Could not send caller ICE candidate:", error));
    };
    listenForRemoteCandidates(call, "calleeCandidates");
    watchCallDocument(call);
    const offer = await peerConnection.createOffer();
    if (activeCall !== call) return;
    await peerConnection.setLocalDescription(offer);
    if (activeCall !== call) return;
    await updateDoc(reference, {
      status: "ringing",
      offer: { type: offer.type, sdp: offer.sdp }
    });
    if (activeCall !== call) return;
    call.ringTimeout = setTimeout(() => {
      if (activeCall !== call || call.role !== "caller") return;
      getDoc(call.reference).then(snapshot => {
        if (activeCall !== call || !snapshot.exists() || snapshot.data().status !== "ringing") return;
        toast("Друг не ответил на звонок.");
        finishAudioCall(true, "cancelled");
      }).catch(error => handleCallError("Could not check audio call status:", error));
    }, 45000);
  } catch (error) {
    if (activeCall !== call) return;
    finishAudioCall(true, "cancelled");
    throw error;
  }
}

async function acceptIncomingAudioCall() {
  const call = activeCall;
  if (!call || call.role !== "callee") return;
  const acceptButton = document.getElementById("accept-call");
  acceptButton.disabled = true;
  try {
    const snapshot = await getDoc(call.reference);
    if (!snapshot.exists() || snapshot.data().status !== "ringing") {
      finishAudioCall(false);
      toast("Этот звонок уже завершён.");
      return;
    }
    if (activeCall !== call) return;
    const offer = snapshot.data().offer;
    if (!offer?.sdp) throw new Error("Не удалось получить приглашение на звонок.");
    const peerConnection = await prepareCallPeerConnection(call);
    peerConnection.onicecandidate = event => {
      if (!event.candidate || activeCall !== call) return;
      addDoc(collection(database, "conversations", call.conversationId, "calls", call.id, "calleeCandidates"), event.candidate.toJSON())
        .catch(error => handleCallError("Could not send callee ICE candidate:", error));
    };
    listenForRemoteCandidates(call, "callerCandidates");
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    if (activeCall !== call) return;
    await applyPendingCandidates(call);
    const answer = await peerConnection.createAnswer();
    if (activeCall !== call) return;
    await peerConnection.setLocalDescription(answer);
    if (activeCall !== call) return;
    await updateDoc(call.reference, {
      status: "accepted",
      answer: { type: answer.type, sdp: answer.sdp }
    });
    call.status = "accepted";
    document.getElementById("incoming-call-dialog").close();
    updateCallUi("connecting", call.friend.username);
  } catch (error) {
    if (activeCall === call) {
      finishAudioCall(true, "rejected");
      handleCallError("Could not accept incoming audio call:", error);
    }
  } finally {
    acceptButton.disabled = false;
  }
}

function rejectIncomingAudioCall() {
  if (!activeCall || activeCall.role !== "callee") return;
  finishAudioCall(true, "rejected");
}

function updateCallSubscriptions(friends) {
  const conversationIds = new Set(friends.map(friend => friend.connectionId));
  for (const [conversationId, stop] of callSubscriptions) {
    if (!conversationIds.has(conversationId)) {
      stop();
      callSubscriptions.delete(conversationId);
    }
  }
  for (const friend of friends) {
    if (callSubscriptions.has(friend.connectionId)) continue;
    const incomingCalls = query(
      collection(database, "conversations", friend.connectionId, "calls"),
      where("calleeId", "==", currentUser.uid),
      where("status", "==", "ringing"),
      limit(1)
    );
    const stop = onSnapshot(incomingCalls, snapshot => {
      if (!snapshot.docs.length) return;
      const incomingSnapshot = snapshot.docs[0];
      if (activeCall?.id === incomingSnapshot.id) return;
      if (activeCall) {
        updateDoc(incomingSnapshot.ref, { status: "rejected" })
          .catch(error => handleCallError("Could not reject busy incoming call:", error));
        return;
      }
      const call = {
        id: incomingSnapshot.id,
        reference: incomingSnapshot.ref,
        conversationId: friend.connectionId,
        friend,
        role: "callee",
        status: "ringing",
        created: true,
        localStream: null,
        peerConnection: null,
        stopCallDocument: null,
        stopRemoteCandidates: null,
        stopLocalCandidates: null,
        pendingCandidates: []
      };
      activeCall = call;
      watchCallDocument(call);
      document.getElementById("incoming-call-name").textContent = `${friend.username} звонит тебе`;
      document.getElementById("incoming-call-dialog").showModal();
      updateCallUi("incoming", friend.username);
    }, error => handleCallError("Incoming call subscription failed:", error));
    callSubscriptions.set(friend.connectionId, stop);
  }
}

function showConfigurationError(error) {
  console.error("Firebase chat configuration or authentication failed:", error);
  toast("Не удалось подключиться к чату. Проверь настройки Firebase и правила Firestore.");
}

function renderFriends(friends) {
  currentFriendList = friends;
  const list = document.getElementById("friends-list");
  list.replaceChildren();
  if (!friends.length) {
    const empty = document.createElement("div");
    empty.className = "friend-empty";
    empty.textContent = "Пока нет друзей. Нажми «+», чтобы найти игрока по нику.";
    list.append(empty);
    return;
  }

  for (const friend of friends) {
    const button = document.createElement("button");
    button.className = `friend-item${currentConversation?.friend.uid === friend.uid ? " active" : ""}`;
    button.type = "button";
    button.dataset.friendId = friend.uid;

    const avatar = document.createElement("span");
    avatar.className = "friend-avatar";
    avatar.textContent = [...friend.username][0].toUpperCase();
    const copy = document.createElement("span");
    copy.className = "friend-copy";
    const name = document.createElement("span");
    name.className = "friend-name";
    name.textContent = friend.username;
    const subtitle = document.createElement("span");
    subtitle.className = "friend-subtitle";
    subtitle.textContent = "Открыть переписку";
    copy.append(name, subtitle);
    button.append(avatar, copy);
    list.append(button);
  }
}

function renderRequests(requests) {
  const container = document.getElementById("friend-requests");
  container.replaceChildren();
  container.hidden = requests.length === 0;
  if (!requests.length) return;

  const label = document.createElement("div");
  label.className = "section-label";
  label.textContent = "Запросы в друзья";
  container.append(label);

  for (const request of requests) {
    const item = document.createElement("div");
    item.className = "friend-request";
    item.textContent = `Новый запрос от ${request.username}`;
    const actions = document.createElement("div");
    actions.className = "friend-request-actions";
    for (const [status, title] of [["accepted", "Принять"], ["rejected", "Отклонить"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = title;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await respondToFriendRequest(request, status);
          toast(status === "accepted" ? `Теперь вы друзья с ${request.username}.` : "Запрос отклонён.");
        } catch (error) {
          console.error("Could not respond to friend request:", error);
          toast("Не удалось обработать запрос. Проверь правила Firestore.");
          button.disabled = false;
        }
      });
      actions.append(button);
    }
    item.append(actions);
    container.append(item);
  }
}

async function subscribeToFriends() {
  if (!currentUser || !currentProfile) return;
  if (stopConnections) stopConnections();
  if (stopRequests) stopRequests();

  const friendQuery = query(
    collection(database, "connections"),
    where("members", "array-contains", currentUser.uid)
  );
  stopConnections = onSnapshot(friendQuery, async snapshot => {
    try {
      const friends = await Promise.all(snapshot.docs.map(async connection => {
        const otherUid = connection.data().members.find(uid => uid !== currentUser.uid);
        if (!otherUid) return null;
        const friendSnapshot = await getDoc(doc(database, "profiles", otherUid));
        if (!friendSnapshot.exists()) return null;
        return { uid: otherUid, ...friendSnapshot.data(), connectionId: connection.id };
      }));
      const validFriends = friends.filter(Boolean).sort((a, b) => a.username.localeCompare(b.username));
      renderFriends(validFriends);
      updateCallSubscriptions(validFriends);
      if (currentConversation) {
        const updatedFriend = validFriends.find(friend => friend.uid === currentConversation.friend.uid);
        if (!updatedFriend) closeConversation();
        else currentConversation.friend = updatedFriend;
      }
    } catch (error) {
      console.error("Could not load Arcade friends:", error);
      toast("Не удалось загрузить список друзей.");
    }
  }, error => {
    console.error("Friend list subscription failed:", error);
    toast("Не удалось загрузить список друзей. Проверь правила Firestore.");
  });

  const requestQuery = query(collection(database, "friendRequests"), where("to", "==", currentUser.uid));
  stopRequests = onSnapshot(requestQuery, async snapshot => {
    try {
      const incoming = snapshot.docs.filter(item => item.data().status === "pending");
      const requests = await Promise.all(incoming.map(async item => {
        const request = item.data();
        const sender = await getDoc(doc(database, "profiles", request.from));
        return sender.exists() ? { id: item.id, ...request, username: sender.data().username } : null;
      }));
      renderRequests(requests.filter(Boolean));
    } catch (error) {
      console.error("Could not load friend requests:", error);
      toast("Не удалось загрузить запросы в друзья.");
    }
  }, error => {
    console.error("Friend request subscription failed:", error);
    toast("Не удалось загрузить запросы. Проверь правила Firestore.");
  });
}

function closeConversation() {
  if (activeCall) finishAudioCall(true, "cancelled");
  if (stopMessages) stopMessages();
  stopMessages = null;
  currentConversation = null;
  document.querySelector(".main").classList.remove("chat-mode");
  document.getElementById("chat-view").hidden = true;
  updateCallUi("idle");
}

function renderMessages(messages) {
  const container = document.getElementById("chat-messages");
  container.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "friend-empty";
    empty.textContent = "Переписка началась. Отправь первое сообщение!";
    container.append(empty);
    return;
  }

  for (const message of messages) {
    const bubble = document.createElement("div");
    bubble.className = `chat-message${message.senderId === currentUser.uid ? " mine" : ""}`;
    bubble.append(document.createTextNode(message.text));
    const time = document.createElement("span");
    time.className = "chat-message-time";
    const date = message.createdAt?.toDate?.();
    time.textContent = date
      ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "сейчас";
    bubble.append(time);
    container.append(bubble);
  }
  container.scrollTop = container.scrollHeight;
}

function openConversation(friend) {
  if (activeCall && activeCall.friend.uid !== friend.uid) {
    finishAudioCall(true, "cancelled");
  }
  const main = document.querySelector(".main");
  main.classList.add("chat-mode");
  document.getElementById("chat-view").hidden = false;
  document.getElementById("chat-empty").hidden = true;
  document.getElementById("chat-thread").hidden = false;
  document.getElementById("chat-name").textContent = friend.username;
  document.getElementById("chat-avatar").textContent = [...friend.username][0].toUpperCase();
  document.getElementById("chat-messages").replaceChildren();
  document.getElementById("chat-input").focus();

  if (stopMessages) stopMessages();
  currentConversation = { friend, id: friend.connectionId };
  if (!activeCall) {
    updateCallUi("idle");
  } else {
    const state = activeCall.peerConnection?.connectionState === "connected"
      ? "active"
      : activeCall.status === "accepted"
        ? "connecting"
        : activeCall.role === "callee"
          ? "incoming"
          : "calling";
    updateCallUi(state, activeCall.friend.username);
  }
  const messagesQuery = query(
    collection(database, "conversations", friend.connectionId, "messages"),
    orderBy("createdAt", "asc"),
    limit(100)
  );
  stopMessages = onSnapshot(messagesQuery, snapshot => {
    renderMessages(snapshot.docs.map(item => item.data()));
  }, error => {
    console.error("Message subscription failed:", error);
    toast("Не удалось загрузить переписку. Проверь правила Firestore.");
  });
  renderFriends(currentFriendList);
}

async function respondToFriendRequest(request, status) {
  const requestReference = doc(database, "friendRequests", request.id);
  if (status === "rejected") {
    await updateDoc(requestReference, { status, respondedAt: serverTimestamp() });
    return;
  }

  const members = [request.from, request.to];
  const batch = writeBatch(database);
  batch.update(requestReference, { status: "accepted", respondedAt: serverTimestamp() });
  batch.set(doc(database, "connections", request.id), {
    requestId: request.id,
    members,
    createdAt: serverTimestamp()
  });
  batch.set(doc(database, "conversations", request.id), {
    requestId: request.id,
    members,
    createdAt: serverTimestamp()
  });
  await batch.commit();
}

async function addFriendByUsername(input) {
  if (!currentUser || !currentProfile) throw new Error("Сначала войди в аккаунт и выбери ник Arcade.");
  const usernameLower = input.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(usernameLower)) {
    throw new Error("Ник должен содержать 3–20 латинских букв, цифр или подчёркиваний.");
  }
  if (usernameLower === currentProfile.usernameLower) throw new Error("Нельзя добавить самого себя.");

  const usernameSnapshot = await getDoc(doc(database, "usernames", usernameLower));
  if (!usernameSnapshot.exists()) throw new Error("Игрок с таким ником не найден.");
  const friendUid = usernameSnapshot.data().uid;
  if (friendUid === currentUser.uid) throw new Error("Нельзя добавить самого себя.");

  const requestId = `${currentUser.uid}_${friendUid}`;
  const reverseRequestId = `${friendUid}_${currentUser.uid}`;
  const [connection, reverseConnection, outgoingRequest, incomingRequest] = await Promise.all([
    getDoc(doc(database, "connections", requestId)),
    getDoc(doc(database, "connections", reverseRequestId)),
    getDoc(doc(database, "friendRequests", requestId)),
    getDoc(doc(database, "friendRequests", reverseRequestId))
  ]);
  if (connection.exists() || reverseConnection.exists()) throw new Error("Вы уже друзья.");
  if (incomingRequest.exists() && incomingRequest.data().status === "pending") {
    throw new Error("Этот игрок уже отправил тебе запрос — проверь список слева.");
  }
  if (outgoingRequest.exists() && outgoingRequest.data().status === "pending") {
    throw new Error("Запрос этому игроку уже отправлен.");
  }

  const request = {
    from: currentUser.uid,
    to: friendUid,
    status: "pending",
    createdAt: serverTimestamp()
  };
  if (outgoingRequest.exists()) {
    await updateDoc(doc(database, "friendRequests", requestId), request);
  } else {
    await setDoc(doc(database, "friendRequests", requestId), request);
  }
}

async function sendMessage(text) {
  if (!currentUser || !currentConversation) throw new Error("Сначала открой переписку с другом.");
  const message = text.trim();
  if (!message) return;
  if (message.length > 2000) throw new Error("Сообщение не должно быть длиннее 2000 символов.");
  await addDoc(collection(database, "conversations", currentConversation.id, "messages"), {
    senderId: currentUser.uid,
    text: message,
    createdAt: serverTimestamp()
  });
}

async function setUsername(input) {
  if (!currentUser) throw new Error("Сначала войди через Google.");
  const username = input.trim();
  const usernameLower = username.toLowerCase();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    throw new Error("Ник должен содержать 3–20 латинских букв, цифр или подчёркиваний.");
  }

  const profileReference = doc(database, "profiles", currentUser.uid);
  const usernameReference = doc(database, "usernames", usernameLower);
  const profile = {
    username,
    usernameLower,
    displayName: currentUser.displayName || username,
    createdAt: serverTimestamp()
  };
  await runTransaction(database, async transaction => {
    const [existingProfile, existingUsername] = await Promise.all([
      transaction.get(profileReference),
      transaction.get(usernameReference)
    ]);
    if (existingProfile.exists()) throw new Error("У аккаунта уже есть ник.");
    if (existingUsername.exists()) throw new Error("Этот ник уже занят. Попробуй другой.");
    transaction.set(usernameReference, { uid: currentUser.uid });
    transaction.set(profileReference, profile);
  });
  currentProfile = profile;
  await subscribeToFriends();
  profileChanged({ ...profile, email: currentUser.email });
  return { ...profile, email: currentUser.email };
}

async function loadCurrentProfile(user) {
  currentUser = user;
  currentProfile = null;
  stopListeners();
  renderFriends([]);
  renderRequests([]);
  if (!user) {
    profileChanged(null);
    return;
  }

  try {
    const profileSnapshot = await getDoc(doc(database, "profiles", user.uid));
    if (!profileSnapshot.exists()) {
      profileChanged({ displayName: user.displayName, email: user.email });
      showUsernameDialog();
      return;
    }
    currentProfile = profileSnapshot.data();
    profileChanged({ ...currentProfile, email: user.email });
    await subscribeToFriends();
  } catch (error) {
    showConfigurationError(error);
  }
}

if (hasFirebaseConfig) {
  try {
    const firebaseApp = initializeApp(firebaseConfig);
    auth = initializeAuth(firebaseApp, { persistence: browserLocalPersistence });
    database = getFirestore(firebaseApp);
    onAuthStateChanged(auth, user => {
      loadCurrentProfile(user).catch(showConfigurationError);
    }, showConfigurationError);
  } catch (error) {
    showConfigurationError(error);
  }
}

document.getElementById("friends-list").addEventListener("click", event => {
  const button = event.target.closest("[data-friend-id]");
  if (!button) return;
  const friend = currentFriendList.find(item => item.uid === button.dataset.friendId);
  if (friend) openConversation(friend);
});

document.getElementById("start-audio-call").addEventListener("click", async () => {
  if (!currentConversation) return;
  try {
    await startAudioCall(currentConversation.friend);
  } catch (error) {
    handleCallError("Could not start audio call:", error);
  }
});
document.getElementById("accept-call").addEventListener("click", acceptIncomingAudioCall);
document.getElementById("reject-call").addEventListener("click", rejectIncomingAudioCall);
document.getElementById("end-audio-call").addEventListener("click", () => finishAudioCall(true));
document.getElementById("toggle-call-mute").addEventListener("click", event => {
  const track = activeCall?.localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  event.currentTarget.textContent = track.enabled ? "Выключить микрофон" : "Включить микрофон";
});
document.getElementById("incoming-call-dialog").addEventListener("cancel", event => {
  event.preventDefault();
});

window.arcadeChat = {
  isSignedIn() {
    return Boolean(currentUser && currentProfile);
  },
  async signInWithGoogle(idToken) {
    if (!hasFirebaseConfig) {
      throw new Error("Firebase ещё не настроен. Сначала подключи Firebase Web App по инструкции в README.");
    }
    if (!auth || !database) throw new Error("Не удалось подключить Firebase. Проверь конфигурацию проекта.");
    if (typeof idToken !== "string" || !idToken) throw new Error("Google не вернул токен входа.");
    try {
      const credential = GoogleAuthProvider.credential(idToken);
      const result = await signInWithCredential(auth, credential);
      currentUser = result.user;
      const snapshot = await getDoc(doc(database, "profiles", currentUser.uid));
      if (snapshot.exists()) {
        currentProfile = snapshot.data();
        await subscribeToFriends();
        return { ...currentProfile, email: currentUser.email };
      }
      profileChanged({ displayName: currentUser.displayName, email: currentUser.email });
      showUsernameDialog();
      return { displayName: currentUser.displayName, email: currentUser.email };
    } catch (error) {
      console.error("Google sign-in to Firebase failed:", error);
      if (error.code === "auth/invalid-credential" || error.code === "auth/operation-not-allowed") {
        throw new Error("Включи вход через Google в Firebase → Authentication → Sign-in method.");
      }
      if (error.code === "auth/unauthorized-domain") {
        throw new Error("Добавь Arcade в Firebase → Authentication → Settings → Authorized domains.");
      }
      if (error.code === "auth/internal-error") {
        throw new Error("Firebase получил Google-вход, но не завершил авторизацию. В Firebase Console проверь Authentication → Sign-in method → Google: провайдер должен быть включён и настроен для Web-приложения. Убедись, что Firebase использует Web OAuth client ID, а не Desktop client ID, и что firebase-config.js указывает на тот же проект. Секрет OAuth не добавляй в Arcade.");
      }
      throw new Error(error.message || "Не удалось войти в Firebase.");
    }
  },
  getCurrentProfile() {
    return currentUser && currentProfile
      ? { ...currentProfile, email: currentUser.email }
      : null;
  },
  closeChat() {
    closeConversation();
  },
  addFriendByUsername,
  setUsername,
  sendMessage
};
