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
  PRESENCE_JOIN: 'presence:join',
  PRESENCE_LEAVE: 'presence:leave',
  PRESENCE_STATE: 'presence:state',

  // ✅ #51
  POLL_START:   'poll:start',
  POLL_END:     'poll:end',
  POLL_ANSWER:  'poll:answer',
  POLL_RESULT:  'poll:result',

  // ✅ #54
  QUESTION_ASK:         'question:ask',
  QUESTION_ACK:         'question:ack',
  QUESTION_NEW:         'question:new',
  QUESTION_LIST:        'question:list',
  QUESTION_LIST_RESULT: 'question:list:result',

  // ✅ #56
  QUESTION_ANSWER:   'question:answer',    // 교사 → 서버 (요청)
  QUESTION_ANSWERED: 'question:answered',  // 서버 → 클라이언트 (통지)

  // ✅ #60
  QUIZ_ACTIVATE:    'quiz:activate',    // 교사 → 서버: 특정 문항 활성화 요청
  QUIZ_DEACTIVATE:  'quiz:deactivate',  // 교사 → 서버: 활성 퀴즈 해제 요청
  QUIZ_ACTIVATED:   'quiz:activated',   // 서버 → 전체: 퀴즈 활성화 알림
  QUIZ_DEACTIVATED: 'quiz:deactivated', // 서버 → 전체: 퀴즈 비활성화 알림

  // ✅ #62
  QUIZ_SUBMIT: 'quiz:submit',  // 학생 → 서버: 답 제출
  QUIZ_RESULT: 'quiz:result',  // 서버 → 학생: 개인 채점 결과
  QUIZ_STATS:  'quiz:stats',   // 서버 → 교사: 집계 현황
};

module.exports = { SOCKET_EVENTS };
