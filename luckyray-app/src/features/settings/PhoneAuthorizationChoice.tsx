import { useId } from "react";
import { defineMessages, useMessages } from "../../core/i18n/index";
import type { CompanionAuthorizationMode } from "../../core/services/companionGateway";
import "./phoneAccessManager.css";

export const PHONE_AUTHORIZATION_COPY = defineMessages({
  title: { "zh-CN": "选择手机权限", "en-US": "Choose phone access" },
  trusted: { "zh-CN": "信任这台手机", "en-US": "Trust this phone" },
  recommended: { "zh-CN": "推荐", "en-US": "Recommended" },
  trustedHint: { "zh-CN": "允许访问此电脑全部现有及未来的素材库、知识库和 LSH。", "en-US": "Allow access to all current and future material and knowledge libraries on this desktop, plus LSH." },
  operations: { "zh-CN": "可读取、导入、编辑、删除和在桌面打开；已关闭权限不会因重连或切库恢复。", "en-US": "Includes reading, importing, editing, deleting and opening on desktop. Reconnecting or switching libraries keeps disabled access off." },
  trustedSummary: { "zh-CN": "覆盖现有及未来的全部库与 LSH，可逐项调整。", "en-US": "All current and future libraries and LSH; adjust access below." },
  manualSummary: { "zh-CN": "仅使用已授权的库和功能。", "en-US": "Only approved libraries and features are available." },
  manual: { "zh-CN": "自己手动授权", "en-US": "Choose access manually" },
  manualHint: { "zh-CN": "按库和功能授权；新手机默认关闭，已有权限保持不变。", "en-US": "Choose access per library and feature. New phones start with access off; existing grants stay unchanged." },
  confirmTrusted: { "zh-CN": "确认信任并继续", "en-US": "Confirm trust and continue" },
  confirmManual: { "zh-CN": "使用手动授权继续", "en-US": "Continue with manual access" },
  confirm: { "zh-CN": "选择后继续", "en-US": "Choose an option to continue" },
  pairingTitle: { "zh-CN": "扫码连接手机", "en-US": "Connect your phone by scanning" },
  pairingHint: { "zh-CN": "选择权限并确认后显示二维码。", "en-US": "Choose access and confirm to show the QR code." },
  pairTrusted: { "zh-CN": "确认信任并生成二维码", "en-US": "Confirm trust and show QR code" },
  pairManual: { "zh-CN": "确认手动授权并生成二维码", "en-US": "Confirm manual access and show QR code" },
  pairChoose: { "zh-CN": "选择权限后生成二维码", "en-US": "Choose access to show QR code" },
  existingOff: { "zh-CN": "已保存的全库服务与 LSH 关闭设置继续生效；手动按库权限不会限制信任模式。", "en-US": "Saved all-library and LSH off-switches stay off. Manual per-library grants do not limit Trusted mode." },
});

export default function PhoneAuthorizationChoice({ value, onChange, disabled = false }: {
  value: CompanionAuthorizationMode | null;
  onChange: (value: CompanionAuthorizationMode) => void;
  disabled?: boolean;
}) {
  const { t } = useMessages(PHONE_AUTHORIZATION_COPY), name = useId();
  return <fieldset className="phone-authorization-choice" disabled={disabled}>
    <legend>{t("title")}</legend>
    <div className="phone-authorization-options">
      {(["trusted", "manual"] as const).map(mode => <label key={mode} className="phone-authorization-option" data-selected={value === mode}>
        <input type="radio" name={name} value={mode} checked={value === mode} aria-describedby={value === mode ? `${name}-scope` : undefined} onChange={() => onChange(mode)} />
        <span>{t(mode)}</span>
      </label>)}
    </div>
    {value && <div id={`${name}-scope`} className="phone-authorization-description">
      <p>{t(value === "trusted" ? "trustedHint" : "manualHint")}</p>
      {value === "trusted" && <p>{t("operations")}</p>}
    </div>}
  </fieldset>;
}
