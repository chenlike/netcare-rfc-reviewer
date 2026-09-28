const messages: Record<string, string> = {
  INVALID_ZIP: "无法读取 ZIP，请确认文件未损坏且未加密",
  INVALID_ZIP_ENTRY: "ZIP 中的文件已损坏，请重新导出方案",
  ZIP_SIZE_LIMIT: "方案包为空或超过 50 MB，请重新选择",
  ZIP_ENTRY_LIMIT: "方案包文件数量过多，请移除无关资源后重试",
  ZIP_EXPANSION_LIMIT: "方案解压后过大或压缩比例异常，请精简方案资源",
  DUPLICATE_ZIP_ENTRY: "方案包含同名资源，请重新导出，避免重复路径",
  UNSAFE_ZIP_ENTRY: "方案包含不安全路径、链接或加密文件，请重新导出普通 ZIP",
  DOCUMENT_SIZE_LIMIT: "HTML 正文过大，请拆分方案或移除无关内容",
  DOCUMENT_PARSE_EMPTY:
    "没有找到可读取的静态 HTML 正文，请上传完整 HTML 导出包",
};
export function readableError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if ((error as any)?.code === "ENOSPC")
    return "本机磁盘空间不足，请释放空间后重试";
  return messages[text] || text;
}
