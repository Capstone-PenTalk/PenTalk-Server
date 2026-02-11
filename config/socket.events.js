const SOCKET_EVENTS = {
  JOIN_ROOM: 'join_room',
  JOIN_SUCCESS: 'join_success',
  JOINED_ROOM: "joined_room",
  TEACHER_SEND_DM: "teacher_send_dm",
  RECEIVE_DM: "receive_dm",
  SEND_MESSAGE: 'send_message',
  RECEIVE_MESSAGE: 'receive_message',
  ERROR: 'server_error',
  DRAW_EVENT: 'draw_event',
};

module.exports = { SOCKET_EVENTS };
