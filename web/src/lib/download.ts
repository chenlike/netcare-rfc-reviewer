let saving = false;

/** Keep Blob alive until WebView2 reports that the native save has finished. */
export async function saveBlob(blob: Blob, name: string, desktop: boolean): Promise<boolean> {
  if (saving) throw new Error('已有导出正在进行，请先完成或取消保存');
  if (desktop && !(window as any).__NETCARE_NATIVE_DOWNLOAD__)
    throw new Error('当前桌面程序未支持保存弹窗，请安装新版后重新导出');
  saving = true;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  document.body.appendChild(anchor);
  try {
    if (!desktop) {
      anchor.click();
      return true;
    }
    return await new Promise<boolean>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (error?: Error, saved = false) => {
        clearTimeout(timeout);
        window.removeEventListener('netcare-download', listen);
        error ? reject(error) : resolve(saved);
      };
      const listen = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        if (detail?.url !== url) return;
        if (detail.status === 'started') {
          clearTimeout(timeout);
          timeout = setTimeout(() => finish(new Error('保存等待超时，请重试导出')), 30 * 60 * 1000);
        } else if (detail.status === 'saved') finish(undefined, true);
        else if (detail.status === 'cancelled') finish();
        else if (detail.status === 'failed') finish(new Error('文件保存失败，请检查目标目录权限、磁盘空间后重试'));
      };
      window.addEventListener('netcare-download', listen);
      timeout = setTimeout(() => finish(new Error('保存弹窗未能打开，请重新打开程序后重试')), 15000);
      try { anchor.click(); } catch (error) { finish(error instanceof Error ? error : new Error('无法启动导出')); }
    });
  } finally {
    anchor.remove();
    // Browsers do not report completion; retain their Blob long enough to start downloading.
    if (desktop) URL.revokeObjectURL(url);
    else setTimeout(() => URL.revokeObjectURL(url), 60000);
    saving = false;
  }
}
