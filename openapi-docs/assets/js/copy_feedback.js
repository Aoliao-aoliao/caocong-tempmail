(function () {
    "use strict";

    async function write(value) {
        const text = String(value == null ? "" : value);
        if (!text) return false;
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (error) {
            const input = document.createElement("textarea");
            input.value = text;
            input.style.position = "fixed";
            input.style.opacity = "0";
            document.body.append(input);
            input.select();
            const copied = document.execCommand("copy");
            input.remove();
            return copied;
        }
    }

    function mark(button) {
        if (!button) return;
        if (!button.copyFeedbackNodes) {
            button.copyFeedbackNodes = Array.from(button.childNodes).map(function (node) {
                return node.cloneNode(true);
            });
            button.copyFeedbackLabel = button.getAttribute("aria-label")
                || document.body.dataset.msgCopy || "";
            button.copyFeedbackHasText = Boolean(button.textContent.trim());
        }
        if (button.copyFeedbackTimer) window.clearTimeout(button.copyFeedbackTimer);
        const icon = document.createElement("span");
        icon.className = "copy-success-mark";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "\u2713";
        button.replaceChildren(icon);
        if (button.copyFeedbackHasText) {
            const label = document.createElement("b");
            label.className = "copy-success-label";
            label.textContent = document.body.dataset.msgCopied || "";
            button.append(label);
        }
        button.classList.add("is-copied");
        button.setAttribute("aria-label", document.body.dataset.msgCopied || "");
        button.copyFeedbackTimer = window.setTimeout(function () {
            button.replaceChildren(...button.copyFeedbackNodes.map(function (node) {
                return node.cloneNode(true);
            }));
            button.classList.remove("is-copied");
            button.setAttribute("aria-label", button.copyFeedbackLabel);
            button.copyFeedbackTimer = undefined;
        }, 3_000);
    }

    async function copy(button, value) {
        if (!await write(value)) return false;
        mark(button);
        return true;
    }

    window.NodeMailCopyFeedback = { copy: copy, mark: mark, write: write };
}());

