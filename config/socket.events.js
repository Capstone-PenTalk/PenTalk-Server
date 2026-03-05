const SOCKET_EVENTS = {
  JOIN_ROOM: 'join_room',
  JOIN_SUCCESS: 'join_success',
  TEACHER_SEND_DM: "teacher_send_dm",
  RECEIVE_DM: "receive_dm",
  SEND_MESSAGE: 'send_message',
  RECEIVE_MESSAGE: 'receive_message',
  ERROR: 'server_error',
  DRAW_APPEND: 'draw:append',
  DRAW_CLEAR: 'draw:clear',
  SYNC_REQUEST: 'sync:request',
  SYNC_STATE: 'sync:state',
  SESSION_ENDED: 'session:ended',
};

module.exports = { SOCKET_EVENTS };
