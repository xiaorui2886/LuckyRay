import { defineMessages } from "../../core/i18n/index";
export const desktopUpdateMessages=defineMessages({
  "disabled": {
    "zh-CN": "当前构建尚未配置签名更新，请使用官方下载页。",
    "en-US": "Signed updates are not enabled in this build. Use the official download page."
  },
  "idle": {
    "zh-CN": "检查可用更新。",
    "en-US": "Check for available updates."
  },
  "checking": {
    "zh-CN": "正在检查更新…",
    "en-US": "Checking for updates…"
  },
  "current": {
    "zh-CN": "当前已是最新版本。",
    "en-US": "You are up to date."
  },
  "available": {
    "zh-CN": "发现新版本，可先下载，稍后安装。",
    "en-US": "An update is available. Download it now and install later."
  },
  "downloading": {
    "zh-CN": "正在下载更新…",
    "en-US": "Downloading update…"
  },
  "verifying": {
    "zh-CN": "正在校验更新包…",
    "en-US": "Verifying the update…"
  },
  "ready": {
    "zh-CN": "更新包已验证。可以立即重启并更新，也可以稍后安装。",
    "en-US": "Verified. Restart and update now, or install later."
  },
  "scheduled": {
    "zh-CN": "已安排下次启动时安装。现在可以继续使用，也可以取消安排。",
    "en-US": "Installation is scheduled for the next launch. You can keep working or cancel it."
  },
  "preparing": {
    "zh-CN": "正在准备更新…",
    "en-US": "Preparing the update…"
  },
  "installing": {
    "zh-CN": "正在交给安装程序，完成后将重新打开。",
    "en-US": "Starting the installer. LuckyRay will reopen when it completes."
  },
  "cancelled": {
    "zh-CN": "已取消更新，当前版本未改变。",
    "en-US": "Update canceled. Your version has not changed."
  },
  "error": {
    "zh-CN": "更新尚未完成，请查看下方说明。",
    "en-US": "The update has not completed. See the details below."
  },
  "update-work-active": {
    "zh-CN": "还有任务正在执行，请完成任务后再安装。",
    "en-US": "Finish running tasks before installing."
  },
  "update-exit-not-safe": {
    "zh-CN": "尚未确认内容保存或后台任务结束，已停止安装。",
    "en-US": "Installation stopped because the application is not ready to exit safely."
  },
  "update-signature-invalid": {
    "zh-CN": "更新包验证失败，请重新检查更新或使用官方下载页。",
    "en-US": "Package verification failed. Check again or use the official download page."
  },
  "update-download-too-large": {
    "zh-CN": "更新包超出允许大小，已停止下载。",
    "en-US": "The download exceeds the permitted size."
  },
  "update-download-length-mismatch": {
    "zh-CN": "下载内容不完整，请重试。",
    "en-US": "The download is incomplete. Please retry."
  },
  "update-network-failed": {
    "zh-CN": "连接更新服务失败，请检查网络后重试。",
    "en-US": "Could not reach the update service. Check your connection and retry."
  },
  "update-install-elevation-required": {
    "zh-CN": "此安装包需要管理员权限，自动安装已停止。请使用官方下载页手动安装。",
    "en-US": "This installer requires administrator privileges. Use the official download page to install it manually."
  },
  "update-install-failed": {
    "zh-CN": "安装程序未能启动，已恢复正常使用。可以重新检查并安排更新。",
    "en-US": "The installer could not start. You can keep working and schedule the update again."
  },
  "update-instance-active": {
    "zh-CN": "另一个软件实例或相关服务仍在运行，本次未安装。请正常退出其他实例后重新安排。",
    "en-US": "Another LuckyRay instance or related service is running. Close it normally before scheduling another attempt."
  },
  "update-ownership-unknown": {
    "zh-CN": "无法确认安装环境是否空闲，本次未安装。可以继续使用当前版本。",
    "en-US": "Could not confirm that installation is safe. No installer was started."
  },
  "update-previous-install-incomplete": {
    "zh-CN": "未确认上次安装完成，已停止自动重试。可重新安排更新；如有异常，请用官方下载的安装包修复。",
    "en-US": "The previous installation was not confirmed complete. Automatic retries are stopped. Reschedule, or use the official installer to repair any problems."
  },
  "update-release-changed": {
    "zh-CN": "已安排的版本发生变化，本次未安装。请重新检查更新。",
    "en-US": "The scheduled release changed. Check for updates again."
  },
  "update-cache-invalid": {
    "zh-CN": "下载缓存不完整，本次未安装。请重新下载。",
    "en-US": "The download cache is incomplete. Please download again."
  },
  "update-connection-failed": {
    "zh-CN": "暂时无法获取更新状态，请重新连接。",
    "en-US": "Update status is unavailable. Please reconnect."
  },
  "loading": {
    "zh-CN": "正在获取更新状态…",
    "en-US": "Getting update status…"
  },
  "version": {
    "zh-CN": "版本 {version}",
    "en-US": "Version {version}"
  },
  "failed": {
    "zh-CN": "操作未完成，请刷新状态后重试。",
    "en-US": "The operation did not complete. Refresh the status and retry."
  },
  "progress": {
    "zh-CN": "更新包下载进度",
    "en-US": "Update download progress"
  },
  "check": {
    "zh-CN": "检查更新",
    "en-US": "Check for updates"
  },
  "download": {
    "zh-CN": "下载更新",
    "en-US": "Download update"
  },
  "cancel": {
    "zh-CN": "取消更新",
    "en-US": "Cancel update"
  },
  "schedule": {
    "zh-CN": "下次启动时安装",
    "en-US": "Install on next launch"
  },
  "restart": {
    "zh-CN": "立即重启并更新",
    "en-US": "Restart and update now"
  },
  "update-editors-not-saved": {
    "zh-CN": "尚有未完成的输入、保存或画布任务，已取消重启。请完成当前操作后再试。",
    "en-US": "Input, saving, or canvas work is unfinished. Restart was cancelled; finish the current work and try again."
  },
  "update-generation-active": {
    "zh-CN": "生成任务仍在运行，未中断任务。请完成后再更新，或选择稍后安装。",
    "en-US": "Generation is still active and has not been interrupted. Finish it before updating, or install later."
  },
  "update-lsh-not-quiescent": {
    "zh-CN": "暂时无法确认 LSH 已安全结束工作，未关闭软件。可以选择稍后安装。",
    "en-US": "LSH cannot yet confirm a safe idle state. LuckyRay remains open; you can install later."
  },
  "update-lsh-task-active": {
    "zh-CN": "LSH 仍有任务、待处理审批或排队输入，未中断这些工作。完成后可重试，或选择稍后安装。",
    "en-US": "LSH has active work, an approval, or queued input. Nothing was interrupted. Finish it and retry, or install later."
  },
  "update-lsh-schedule-active": {
    "zh-CN": "LSH 仍有启用中的定时任务，暂未安排立即退出。请检查任务后重试，或选择稍后安装。",
    "en-US": "LSH still has an active schedule. Check its work before retrying, or install later."
  },
  "update-lsh-draft-pending": {
    "zh-CN": "LSH 输入框仍有未提交的文字或附件，未关闭软件。请处理输入后重试，或选择稍后安装。",
    "en-US": "An LSH composer has unsubmitted text or attachments. LuckyRay remains open. Handle the draft and retry, or install later."
  },
  "update-lsh-composition-pending": {
    "zh-CN": "LSH 输入法组合尚未结束，已停止更新退出。请先完成选字或取消输入。",
    "en-US": "LSH has an unfinished input composition. Update exit was stopped; commit or cancel the composition first."
  },
  "update-lsh-save-failed": {
    "zh-CN": "LSH 尚未确认会话已安全保存，未启动安装。软件仍可使用，请检查保存状态。",
    "en-US": "LSH could not confirm durable session saving. Installation was not started; check its save state."
  },
  "update-lsh-save-timeout": {
    "zh-CN": "等待 LSH 保存超时，未启动安装，也未强行结束任务。请检查状态后重试。",
    "en-US": "LSH saving timed out. Installation was not started and work was not forced to stop. Check its state before retrying."
  },
  "update-lsh-exit-timeout": {
    "zh-CN": "LSH 尚未确认正常退出，未启动安装。请等待后台退出完成后重试。",
    "en-US": "LSH has not confirmed normal exit. Installation was not started; wait for shutdown to settle before retrying."
  },
  "update-lsh-content-changed": {
    "zh-CN": "LSH 会话在保存确认后又发生变化，未启动安装。请等待当前保存完成，或选择稍后安装。",
    "en-US": "The LSH session changed after its save confirmation. Installation was not started; wait for saving to settle, or install later."
  },
  "update-lsh-state-unavailable": {
    "zh-CN": "无法可靠核对 LSH 当前状态，未启动安装。请检查 LSH，或选择稍后安装。",
    "en-US": "LSH state could not be verified reliably. Installation was not started. Check LSH, or install later."
  },
  "update-lsh-client-timeout": {
    "zh-CN": "LSH 界面未及时确认输入状态，未关闭软件。可稍后重试或选择稍后安装。",
    "en-US": "The LSH page did not confirm its input state in time. LuckyRay remains open; retry later or schedule the update."
  },
  "update-quit-in-progress": {
    "zh-CN": "另一次正常退出正在处理，本次未重复退出。",
    "en-US": "A normal exit is already in progress; no duplicate exit was started."
  },
  "update-service-drain-incomplete": {
    "zh-CN": "后台服务尚未确认退出，未启动安装。请检查任务状态后重试。",
    "en-US": "Background services have not confirmed shutdown. Installation was not started; check task status before retrying."
  },
  "reconnect": {
    "zh-CN": "重新连接",
    "en-US": "Reconnect"
  },
  "confirmLabel": {
    "zh-CN": "确认安装更新",
    "en-US": "Confirm update schedule"
  },
  "confirmText": {
    "zh-CN": "本次操作不会关闭软件或中断任务。下次由你正常启动 LuckyRay 时，会在后台服务启动前校验并运行安装程序，完成后重新打开。",
    "en-US": "This will not close LuckyRay or interrupt your tasks. On your next normal launch, the package will be verified and installed before background services start. LuckyRay will then reopen."
  },
  "later": {
    "zh-CN": "稍后安装",
    "en-US": "Later"
  },
  "confirm": {
    "zh-CN": "确认安排",
    "en-US": "Confirm schedule"
  }
});
