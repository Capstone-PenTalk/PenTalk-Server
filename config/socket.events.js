const SOCKET_EVENTS = {
  JOIN_ROOM: 'join-room',
  JOIN_SUCCESS: 'join-success',
  JOINED_ROOM: "joined-room",
  TEACHER_SEND_DM: "teacher-send-dm",
  RECEIVE_DM: "receive-dm",
  SEND_MESSAGE: 'send-message',
  RECEIVE_MESSAGE: 'receive-message',
  ERROR: 'server-error',
};

module.exports = { SOCKET_EVENTS };
