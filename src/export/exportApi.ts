import { invoke } from "@tauri-apps/api/core";

export async function exportHtmlDocument(
  suggestedName: string,
  htmlContent: string,
) {
  return invoke<string | null>("export_html_file", {
    request: {
      suggestedName,
      htmlContent,
    },
  });
}
