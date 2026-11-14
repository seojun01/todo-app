// 설정 화면: 이 기기 정보, 지금 동기화. 이후 스토리가 알림과 내보내기 항목을 더한다.
import type { ViewRenderer } from '../app.ts';
import { buildLocalExport, downloadJson, exportFilename } from '../export.ts';
import { renderGcalSection } from './gcal-settings.ts';
import { renderNotifySection } from './notify-settings.ts';
import { h } from './dom.ts';
import { describeStatus } from '../sync/status.ts';

interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  createdAt: string;
}

async function loadDevice(): Promise<DeviceInfo | null> {
  try {
    const res = await fetch('/api/devices/me', { credentials: 'same-origin' });
    return res.ok ? ((await res.json()) as DeviceInfo) : null;
  } catch {
    return null;
  }
}

export const renderSettings: ViewRenderer = async (app, root) => {
  root.appendChild(h('div', { class: 'view-header' }, h('h2', {}, '설정')));

  const status = await app.sync.status();
  const view = describeStatus(status);
  const info = h('p', { class: 'hint' }, '불러오는 중…');
  const section = h(
    'section',
    { class: 'section', 'aria-labelledby': 'device-heading' },
    h('div', { class: 'section-head' }, h('h3', { id: 'device-heading' }, '이 기기')),
    info,
    h('p', { class: 'hint' }, `동기화 상태: ${view.text}`),
  );
  if (status.paired) {
    const syncBtn = h('button', { type: 'button', class: 'btn' }, '지금 동기화');
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      const s = await app.sync.syncNow();
      app.toasts.show(describeStatus(s).text, { duration: 4000 });
      syncBtn.disabled = false;
      await app.refresh();
    });
    section.appendChild(syncBtn);
  } else {
    section.appendChild(h('a', { class: 'btn btn-primary', href: '#/pair' }, '이 기기 등록하기'));
  }
  root.appendChild(section);

  root.appendChild(await renderNotifySection(app));
  root.appendChild(renderGcalSection(app, status.paired));

  // 내 데이터: 홈서버와 별도로 백업하거나 다른 곳으로 옮길 수 있게 JSON 으로 내려받는다
  const exportBtn = h('button', { type: 'button', class: 'btn' }, '내보내기');
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    try {
      const now = app.ctx.now();
      downloadJson(exportFilename(now), await buildLocalExport(app.ctx.db, now));
      app.toasts.show('내보냈어요', { duration: 3000 });
    } catch (err) {
      console.error(err);
      app.toasts.show('내보내지 못했어요. 다시 시도해 주세요.', { duration: 6000 });
    } finally {
      exportBtn.disabled = false;
    }
  });
  root.appendChild(
    h(
      'section',
      { class: 'section', 'aria-labelledby': 'data-heading' },
      h('div', { class: 'section-head' }, h('h3', { id: 'data-heading' }, '내 데이터')),
      h('p', { class: 'hint' }, '모든 프로젝트와 할 일을 사람이 읽을 수 있는 JSON 파일로 저장해요.'),
      exportBtn,
    ),
  );

  const dev = status.paired ? await loadDevice() : null;
  info.textContent = dev
    ? `${dev.deviceName} · 등록 ${new Date(dev.createdAt).toLocaleDateString('ko-KR')}`
    : status.paired
      ? '기기 정보를 불러오지 못했어요 (오프라인이거나 등록이 해제되었어요).'
      : '이 기기는 홈서버에 등록되지 않았어요. 등록하기 전에도 로컬로 모든 기능을 쓸 수 있어요.';
};
