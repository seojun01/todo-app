// 동기화 상태를 사용자에게 보여 줄 문구로 바꾼다 (FR-034). 색깔만으로 구분하지 않고 항상 글로 설명한다.
import type { SyncStatus } from './engine.ts';

export interface StatusView {
  text: string;
  /** 등록 안내처럼 누를 수 있는 링크가 있을 때 */
  link?: { label: string; href: string };
}

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function describeStatus(s: SyncStatus): StatusView {
  switch (s.state) {
    case 'unauthorized':
      return s.paired
        ? { text: '이 기기의 등록이 해제되었어요', link: { label: '다시 등록하기', href: '#/pair' } }
        : { text: '홈서버에 등록되지 않음', link: { label: '등록하기', href: '#/pair' } };
    case 'offline':
      return { text: s.pending > 0 ? `홈서버에 연결 안 됨 · 변경 ${s.pending}개 대기 중` : '홈서버에 연결 안 됨' };
    case 'pending':
      return { text: `동기화 대기 중 ${s.pending}개` };
    case 'synced':
      return { text: s.lastSyncAt ? `동기화됨 · ${hhmm(s.lastSyncAt)}` : '동기화됨' };
  }
}
