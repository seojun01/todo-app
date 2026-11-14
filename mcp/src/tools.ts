// MCP 도구 목록. 이름·설명·입력 스키마는 모델이 읽는 부분이라 무엇을 하는지 분명히 적는다.
import {
  addTask,
  completeTask,
  deleteTask,
  listProjects,
  listTasks,
  reopenTask,
  searchTasks,
  updateTask,
  type Args,
  type Ctx,
} from './tasks.ts';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
  /** 데이터를 바꾸는 도구인가 (읽기 전용 모드에서는 목록에서 뺀다) */
  write: boolean;
  run(args: Args): Promise<unknown>;
}

const DATE = 'YYYY-MM-DD 형식의 날짜';
const TIME = 'HH:MM (24시간) 형식의 시각. 기한 날짜가 있어야 해요';

const RECURRENCE = {
  type: ['object', 'null'],
  description:
    '반복 규칙. null 이면 반복 없음. 기한 날짜가 필요해요. 예: 매주 월·수 → {"unit":"week","interval":1,"weekdays":[1,3]}, 매월 15일 → {"unit":"month","interval":1,"day_of_month":15}',
  properties: {
    unit: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
    interval: { type: 'integer', minimum: 1, maximum: 99, description: '몇 단위마다 (기본 1)' },
    weekdays: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: 'unit=week 일 때 필수. 0=일요일 … 6=토요일' },
    day_of_month: { type: 'integer', minimum: 1, maximum: 31, description: 'unit=month 또는 year 일 때 필수' },
    month: { type: 'integer', minimum: 1, maximum: 12, description: 'unit=year 일 때 필수' },
    end_date: { type: 'string', description: `반복이 끝나는 날짜. ${DATE}` },
  },
  required: ['unit'],
  additionalProperties: false,
};

const REMINDERS = {
  type: 'array',
  items: { type: 'string', enum: ['at', '10m', '30m', '1h', '1d', 'day'] },
  description: '알림. 기한 시각이 있으면 at(정시)·10m·30m·1h(1시간 전)·1d(하루 전), 시각이 없으면 day(당일)·1d(하루 전)만 쓸 수 있어요. 기한 날짜가 필요해요',
};

export function buildTools(getCtx: () => Ctx, opts: { readOnly: boolean }): ToolDef[] {
  const tools: ToolDef[] = [
    {
      name: 'list_tasks',
      description:
        '할 일 목록을 봅니다. 기본은 오늘 화면(기한이 지난 것 + 오늘 기한)이에요. 우선순위(1이 가장 높음)와 시각 순으로 정렬돼요. 반복 할 일은 현재 기한의 하나만 나옵니다.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['today', 'upcoming', 'overdue', 'no_date', 'all'], description: 'today=오늘+기한 지남(기본), upcoming=내일부터 days일, overdue=기한 지남, no_date=기한 없음, all=전부' },
          days: { type: 'integer', minimum: 1, maximum: 90, description: 'scope=upcoming 일 때 오늘부터 며칠 앞까지 (기본 7)' },
          project: { type: 'string', description: '프로젝트 이름이나 "수신함"으로 거르기' },
          tag: { type: 'string', description: '태그로 거르기 (# 없이)' },
          include_completed: { type: 'boolean', description: '완료한 할 일도 포함 (기본 false)' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: '최대 개수 (기본 50)' },
        },
        additionalProperties: false,
      },
      annotations: { title: '할 일 목록', readOnlyHint: true, openWorldHint: false },
      write: false,
      run: (a) => listTasks(getCtx(), a),
    },
    {
      name: 'search_tasks',
      description: '제목이나 태그에 검색어가 들어 있는 할 일을 찾습니다 (대소문자 무시).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '검색어' },
          include_completed: { type: 'boolean', description: '완료한 할 일도 포함 (기본 false)' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { title: '할 일 검색', readOnlyHint: true, openWorldHint: false },
      write: false,
      run: (a) => searchTasks(getCtx(), a),
    },
    {
      name: 'list_projects',
      description: '프로젝트 목록과 프로젝트별 미완료 할 일 수를 봅니다. 수신함은 항상 있어요.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: '프로젝트 목록', readOnlyHint: true, openWorldHint: false },
      write: false,
      run: () => listProjects(getCtx()),
    },
    {
      name: 'add_task',
      description: '새 할 일을 추가합니다. 기한을 말하지 않으면 기한 없는 할 일이 돼요. 상대 날짜(내일, 다음 주 월요일)는 먼저 오늘 날짜를 알아내 YYYY-MM-DD 로 바꿔서 넣으세요.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '제목 (1~200자)' },
          due_date: { type: ['string', 'null'], description: DATE },
          due_time: { type: ['string', 'null'], description: TIME },
          priority: { type: 'integer', minimum: 1, maximum: 4, description: '1이 가장 높음, 4가 가장 낮음(기본)' },
          project: { type: 'string', description: '프로젝트 이름. 없으면 수신함. 없는 이름이면 오류 (프로젝트를 새로 만들지는 않아요)' },
          tags: { type: 'array', items: { type: 'string' }, description: '태그 (# 없이, 최대 10개)' },
          reminders: REMINDERS,
          recurrence: RECURRENCE,
        },
        required: ['title'],
        additionalProperties: false,
      },
      annotations: { title: '할 일 추가', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      write: true,
      run: (a) => addTask(getCtx(), a),
    },
    {
      name: 'update_task',
      description:
        '할 일의 일부 항목을 바꿉니다. 넘긴 항목만 바뀌고 나머지는 그대로예요. due_date 를 null 로 하면 기한과 함께 시각·반복·알림도 지워집니다. 완료 처리는 complete_task 를 쓰세요.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'list_tasks 가 돌려준 id (앞 8자 이상이면 돼요)' },
          title: { type: 'string' },
          due_date: { type: ['string', 'null'], description: `${DATE}. null 이면 기한 없음` },
          due_time: { type: ['string', 'null'], description: `${TIME}. null 이면 시각 없음` },
          priority: { type: 'integer', minimum: 1, maximum: 4 },
          project: { type: 'string', description: '옮길 프로젝트 이름 ("수신함" 가능)' },
          tags: { type: 'array', items: { type: 'string' }, description: '태그 전체를 이 목록으로 바꿉니다' },
          reminders: REMINDERS,
          recurrence: RECURRENCE,
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { title: '할 일 수정', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      write: true,
      run: (a) => updateTask(getCtx(), a),
    },
    {
      name: 'complete_task',
      description: '할 일을 완료합니다. 반복 할 일이면 이번 회차만 완료하고 기한이 다음 회차로 넘어가요 (앱과 같은 동작).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'list_tasks 가 돌려준 id' } },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { title: '할 일 완료', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      write: true,
      run: (a) => completeTask(getCtx(), a),
    },
    {
      name: 'reopen_task',
      description: '완료한 할 일을 다시 미완료로 돌립니다. 완료한 할 일의 id 는 list_tasks 나 search_tasks 를 include_completed=true 로 불러서 찾으세요.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { title: '완료 취소', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      write: true,
      run: (a) => reopenTask(getCtx(), a),
    },
    {
      name: 'delete_task',
      description: '할 일을 삭제합니다. 앱의 삭제와 같아서 모든 기기에서 사라져요. 사용자가 분명히 삭제를 원할 때만 쓰세요.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { title: '할 일 삭제', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      write: true,
      run: (a) => deleteTask(getCtx(), a),
    },
  ];
  return opts.readOnly ? tools.filter((t) => !t.write) : tools;
}
