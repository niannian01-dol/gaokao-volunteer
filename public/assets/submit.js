/**
 * 宿舍信息投稿表单逻辑。
 * 提交到 /api/submit；无后端（静态托管）时给出可理解的提示。
 */

const $ = (selector, scope = document) => scope.querySelector(selector);

const FIELD_KEYS = [
  "roommates",
  "lightsOut",
  "transport",
  "bedDesk",
  "morningExercise",
  "eveningStudy",
  "bathroom",
  "airConditioner",
  "takeout",
  "canteen",
  "note",
];

function readForm(form) {
  const out = { university: form.university.value.trim(), campus: form.campus.value.trim() };
  for (const key of FIELD_KEYS) {
    const value = form[key]?.value?.trim() ?? "";
    if (value) out[key] = value;
  }
  return out;
}

async function submit(payload) {
  const res = await fetch("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

function renderResult(target, html) {
  target.innerHTML = html;
}

async function main() {
  const form = $("#submit-form");
  if (!form) return;

  const params = new URLSearchParams(location.search);
  const university = params.get("university");
  if (university) form.university.value = university;

  $("#reset-btn")?.addEventListener("click", () => {
    form.reset();
    if (university) form.university.value = university;
    form.campus.value = "主校区";
  });

  const wrap = form.closest(".card");
  const result = $("#submit-result") || form.appendChild(Object.assign(document.createElement("div"), { id: "submit-result" }));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = readForm(form);
    if (!payload.university || !payload.campus) {
      if (wrap) wrap.insertAdjacentHTML("afterbegin", '<div class="notice">请填写院校名称和校区。</div>');
      return;
    }

    const button = form.querySelector('button[type="submit"]');
    if (button) {
      button.disabled = true;
      button.textContent = "提交中…";
    }

    try {
      const data = await submit(payload);
      const persisted = data.persisted === false ? "（本地演示模式，未写入线上库）" : "";
      renderResult(
        result,
        `<div class="notice" style="background: var(--bao-soft); color: var(--bao)">✅ 投稿成功，感谢分享。${persisted}</div>`,
      );
      form.reset();
      if (university) form.university.value = university;
      form.campus.value = "主校区";
    } catch (error) {
      renderResult(
        result,
        `<div class="notice" style="background: var(--chong-soft); color: var(--chong)">投稿失败：${error.message}</div>`,
      );
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "提交投稿";
      }
    }
  });
}

main();
