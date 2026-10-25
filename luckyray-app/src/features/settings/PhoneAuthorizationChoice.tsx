import { useId } from "react";
import { defineMessages, useMessages } from "../../core/i18n/index";
import type { CompanionAuthorizationMode } from "../../core/services/companionGateway";
import "./phoneAccessManager.css";

export const PHONE_AUTHORIZATION_COPY = defineMessages({
  title: { "zh-CN": "选择手机权限", "en-US": "Choose phone access" },
  trusted: { "zh-CN": "信任这台手机", "en-US": "Trust this phone" },
  recommended: { "zh-CN": "推荐", "en-US": "Recommended" },
  trustedHint: { "zh-CN": "开启全部已支持的素材库、知识库服务和 LSH。包含当前及未来保存在这台电脑上的所有库，切库无需再次授权。", "en-US": "Enable all supported material and knowledge services, plus LSH, for all libraries saved on this desktop now and in the future. No new approval when switching libraries." },
  operations: { "zh-CN": "包含读取、导入、编辑与删除、在桌面打开。之后可逐项关闭，已关闭的服务不会因切库或重连而重新开启。", "en-US": "Includes reading, importing, editing and deletion, and opening on desktop. Turn services off individually anytime; switching libraries or reconnecting will not turn them back on." },
  manual: { "zh-CN": "自己手动授权", "en-US": "Choose access manually" },
  manualHint: { "zh-CN": "保留按库、按功能授权。新手机的服务默认关闭；已有手机保留原有手动权限。", "en-US": "Manage access per library and feature. Services start off for a new phone; existing phones keep their manual grants." },
  confirmTrusted: { "zh-CN": "确认信任并继续", "en-US": "Confirm trust and continue" },
  confirmManual: { "zh-CN": "使用手动授权继续", "en-US": "Continue with manual access" },
  confirm: { "zh-CN": "选择后继续", "en-US": "Choose an option to continue" },
  pairingTitle: { "zh-CN": "扫码连接手机", "en-US": "Connect your phone by scanning" },
  pairingHint: { "zh-CN": "选择权限模式，确认后在此显示配对二维码。", "en-US": "Choose an access mode, then confirm to show a pairing QR code here." },
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
