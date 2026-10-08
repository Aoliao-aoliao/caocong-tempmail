(function () {
    "use strict";

    const languages = [
        ["json", "JSON"], ["java", "Java"], ["csharp", "C#"], ["python", "Python"],
        ["nodejs", "Node.js"], ["php", "PHP"], ["curl", "cURL"]
    ];
    const baseUrl = window.location.origin;

    function literal(body) {
        return JSON.stringify(JSON.parse(body));
    }

    function pretty(body) {
        return JSON.stringify(JSON.parse(body), null, 2);
    }

    function example(language, path, body, method) {
        const url = baseUrl + path;
        const get = method === "GET";
        const compact = get ? "" : literal(body);
        if (language === "json") return pretty(body);
        if (language === "java") {
            const requestMethod = get
                ? `.header("apiKey", "YOUR_API_KEY")
    .GET()`
                : `.header("Content-Type", "application/json")
    .header("apiKey", "YOUR_API_KEY")
    .POST(HttpRequest.BodyPublishers.ofString("${compact.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"))`;
            return `import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

var client = HttpClient.newHttpClient();
var request = HttpRequest.newBuilder(URI.create("${url}"))
    ${requestMethod}
    .build();
var response = client.send(request, HttpResponse.BodyHandlers.ofString());
System.out.println(response.body());`;
        }
        if (language === "csharp") {
            const request = get
                ? `var response = await client.GetAsync("${url}");`
                : `var content = new StringContent(@"${compact.replace(/"/g, '""')}", Encoding.UTF8, "application/json");
var response = await client.PostAsync("${url}", content);`;
            return `using System.Net.Http;
using System.Text;

using var client = new HttpClient();
client.DefaultRequestHeaders.Add("apiKey", "YOUR_API_KEY");
${request}
Console.WriteLine(await response.Content.ReadAsStringAsync());`;
        }
        if (language === "python") {
            const request = get
                ? `response = requests.get(
    "${url}",
    headers={"apiKey": "YOUR_API_KEY"},
    timeout=10,
)`
                : `response = requests.post(
    "${url}",
    headers={"apiKey": "YOUR_API_KEY"},
    json=${pretty(body).replace(/true/g, "True").replace(/false/g, "False").replace(/null/g, "None")},
    timeout=10,
)`;
            return `import requests

${request}
print(response.json())`;
        }
        if (language === "nodejs") {
            const options = get
                ? `{
  headers: { apiKey: "YOUR_API_KEY" }
}`
                : `{
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    apiKey: "YOUR_API_KEY"
  },
  body: JSON.stringify(${pretty(body)})
}`;
            return `const response = await fetch("${url}", ${options});

console.log(await response.json());`;
        }
        if (language === "php") {
            const options = get
                ? `CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => ["apiKey: YOUR_API_KEY"],`
                : `CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        "Content-Type: application/json",
        "apiKey: YOUR_API_KEY"
    ],
    CURLOPT_POSTFIELDS => '${compact.replace(/'/g, "\\'")}',`;
            return `<?php
$curl = curl_init("${url}");
curl_setopt_array($curl, [
    ${options}
    CURLOPT_TIMEOUT => 10
]);
$response = curl_exec($curl);
curl_close($curl);
echo $response;`;
        }
        if (get) return `curl --request GET "${url}" \\
  --header "apiKey: YOUR_API_KEY"`;
        return `curl --request POST "${url}" \\
  --header "Content-Type: application/json" \\
  --header "apiKey: YOUR_API_KEY" \\
  --data '${compact.replace(/'/g, "'\\''")}'`;
    }

    function escapeHtml(value) {
        return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function highlight(value, language) {
        const source = String(value || "");
        const tokens = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|\b\d+(?:\.\d+)?\b|\b(?:import|var|new|class|public|private|static|void|using|await|const|let|function|return|if|else|true|false|null|None|True|False|echo)\b)/g;
        let output = "";
        let offset = 0;
        source.replace(tokens, function (token, _capture, index) {
            output += escapeHtml(source.slice(offset, index));
            let type = "keyword";
            if (/^['"`]/.test(token)) type = "string";
            else if (/^(\/\/|\/\*|#)/.test(token) && !(language === "php" && token === "<?php")) type = "comment";
            else if (/^\d/.test(token)) type = "number";
            output += '<span class="tok-' + type + '">' + escapeHtml(token) + "</span>";
            offset = index + token.length;
            return token;
        });
        return output + escapeHtml(source.slice(offset));
    }

    function copyButton(source, className) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = className || "code-copy";
        button.textContent = document.body.dataset.msgCopy || "";
        button.setAttribute("aria-label", document.body.dataset.msgCopy || "");
        button.title = document.body.dataset.msgCopy || "";
        button.addEventListener("click", async function () {
            const value = typeof source === "function" ? source() : source;
            if (window.NodeMailCopyFeedback) await window.NodeMailCopyFeedback.copy(button, value || "");
        });
        return button;
    }

    document.querySelectorAll("[data-code-sample]").forEach(function (root) {
        const path = root.dataset.path;
        const method = (root.dataset.method || "POST").toUpperCase();
        const body = root.dataset.body || "{}";
        const availableLanguages = method === "GET"
            ? languages.filter(function (entry) { return entry[0] !== "json"; })
            : languages;
        const bar = document.createElement("div");
        bar.className = "language-bar";
        bar.setAttribute("role", "tablist");
        const pre = document.createElement("pre");
        pre.className = "code-box";
        const code = document.createElement("code");
        pre.append(code);
        let current = availableLanguages[0][0];

        function select(language) {
            current = language;
            const value = example(language, path, body, method);
            code.dataset.source = value;
            code.innerHTML = highlight(value, language);
            bar.querySelectorAll(".language-tab").forEach(function (button) {
                const selected = button.dataset.language === language;
                button.classList.toggle("active", selected);
                button.setAttribute("aria-selected", String(selected));
            });
        }

        availableLanguages.forEach(function (entry) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "language-tab";
            button.dataset.language = entry[0];
            button.setAttribute("role", "tab");
            button.textContent = entry[1];
            button.addEventListener("click", function () { select(entry[0]); });
            bar.append(button);
        });
        const copy = copyButton(function () {
            return code.dataset.source || example(current, path, body, method);
        });
        bar.append(copy);
        root.append(bar, pre);
        select(current);
    });

    document.querySelectorAll("[data-json]").forEach(function (code) {
        let value = code.textContent;
        try {
            value = JSON.stringify(JSON.parse(code.textContent), null, 2);
            code.innerHTML = highlight(value, "json");
        } catch (_ignored) {
            code.textContent = code.textContent;
        }
        code.dataset.source = value;
        const pre = code.closest(".response-code");
        if (!pre || pre.previousElementSibling?.classList.contains("response-toolbar")) return;
        const toolbar = document.createElement("div");
        toolbar.className = "response-toolbar";
        toolbar.append(copyButton(function () { return code.dataset.source || code.textContent; }, "code-copy response-copy"));
        pre.before(toolbar);
        pre.classList.add("has-copy-toolbar");
    });

    document.querySelectorAll("[data-copy-text]").forEach(function (button) {
        button.addEventListener("click", async function () {
            if (window.NodeMailCopyFeedback) await window.NodeMailCopyFeedback.copy(button, button.dataset.copyText || "");
        });
    });

    const backToTop = document.querySelector("[data-back-to-top]");
    if (backToTop) {
        function updateBackToTop() {
            backToTop.classList.toggle("visible", window.scrollY > 480);
        }
        window.addEventListener("scroll", updateBackToTop, { passive: true });
        backToTop.addEventListener("click", function () {
            window.scrollTo({ top: 0, behavior: "smooth" });
        });
        updateBackToTop();
    }
})();

