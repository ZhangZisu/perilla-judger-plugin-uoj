"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const debug = require("debug");
const fs_1 = require("fs");
const jsdom_1 = require("jsdom");
const path_1 = require("path");
const superagent_1 = require("superagent");
const interfaces_1 = require("./interfaces");
const MAX_SOURCE_SIZE = 16 * 1024 * 1024;
const UPDATE_INTERVAL = 1000;
const configPath = path_1.join(__dirname, "..", "config.json");
const config = JSON.parse(fs_1.readFileSync(configPath).toString());
const agent = superagent_1.agent();
const log = debug("perilla:judger:plugin:uoj");
const isLoggedIn = async () => {
    const result = await agent.get("http://uoj.ac/login");
    return !!result.redirects.length;
};
const initRequest = async () => {
    const loginPage = await agent
        .get("http://uoj.ac/login")
        .set("Host", "uoj.ac")
        .set("Referer", "http://uoj.ac/login/")
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36");
    const token = /_token : "([a-zA-Z0-9]+)"/.exec(loginPage.text)[1];
    log(token);
    const md5 = require(path_1.join(__dirname, "uoj_md5"));
    const loginRes = await agent
        .post("http://uoj.ac/login")
        .set("Host", "uoj.ac")
        .set("Referer", "http://uoj.ac/login")
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36")
        .set("X-Requested-With", "XMLHttpRequest")
        .send("_token=" + token)
        .send("login=")
        .send("username=" + config.username)
        .send("password=" + md5(config.password, "uoj233_wahaha!!!!"));
    if (!await isLoggedIn()) {
        throw new Error("Login failed");
    }
    log("Done");
};
const submit = async (id, code, langname) => {
    try {
        const URL = "http://uoj.ac/problem/" + id;
        const problemPage = await agent
            .get(URL)
            .set("Host", "uoj.ac")
            .set("Referer", "http://uoj.ac/login/")
            .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36");
        const token = /name=\"_token\" value=\"([a-zA-Z0-9]+)\"/.exec(problemPage.text)[1];
        log(token);
        const preCheck = await agent
            .post(URL)
            .set("Host", "uoj.ac")
            .set("Origin", "http://uoj.ac")
            .set("Referer", URL)
            .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36")
            .set("X-Requested-With", "XMLHttpRequest")
            .send("check-answer=");
        const submissions = await agent
            .post(URL)
            .set("Host", "uoj.ac")
            .set("Origin", "http://uoj.ac")
            .set("Referer", URL)
            .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36")
            .send("_token=" + encodeURIComponent(token))
            .send("answer_answer_language=" + encodeURIComponent(langname))
            .send("answer_answer_upload_type=editor")
            .send("answer_answer_editor=" + encodeURIComponent(code))
            .send("submit-answer=answer");
        const dom = new jsdom_1.JSDOM(submissions.text);
        const resultTable = dom.window.document.querySelector("body > div > div.uoj-content > div.table-responsive > table > tbody");
        const resultRows = resultTable.querySelectorAll("tr");
        for (const resultRow of resultRows) {
            if (!resultRow.childNodes[2]) {
                continue;
            }
            if (resultRow.childNodes[2].textContent !== config.username) {
                continue;
            }
            return parseInt(resultRow.childNodes[0].textContent.trim().substr(1), 10);
        }
        throw new Error("Submit failed");
    }
    catch (e) {
        throw e;
    }
};
const updateMap = new Map();
const convertStatus = (text) => {
    try {
        const score = parseInt(text, 10);
        if (score < 0 || score > 100 || isNaN(score)) {
            throw new Error("Invalid score");
        }
        return {
            score,
            status: score === 100 ? interfaces_1.SolutionResult.Accepted : interfaces_1.SolutionResult.OtherError,
        };
    }
    catch (e) {
        switch (text) {
            case "Waiting":
            case "Waiting Rejudge":
                return { status: interfaces_1.SolutionResult.WaitingJudge, score: 0 };
            case "Compiling":
            case "Judging":
                return { status: interfaces_1.SolutionResult.Judging, score: 0 };
            case "Compile Error":
                return { status: interfaces_1.SolutionResult.CompileError, score: 0 };
            case "Judgement Failed":
                return { status: interfaces_1.SolutionResult.JudgementFailed, score: 0 };
        }
        return {
            status: interfaces_1.SolutionResult.OtherError,
            score: 0,
        };
    }
};
const fetch = async (runID) => {
    try {
        const URL = "http://uoj.ac/submission/" + runID;
        const submissionPage = await agent
            .get(URL)
            .set("Host", "uoj.ac")
            .set("Referer", "http://uoj.ac/submissions/")
            .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36");
        const dom = new jsdom_1.JSDOM(submissionPage.text);
        const resultRow = dom.window.document.querySelector("body > div > div.uoj-content > div.table-responsive > table > tbody").childNodes[0];
        const { status, score } = convertStatus(resultRow.childNodes[3].textContent.trim());
        const result = {
            status,
            score,
            details: {
                runID,
                time: resultRow.childNodes[4].textContent.trim(),
                memory: resultRow.childNodes[5].textContent.trim(),
                remoteUser: resultRow.childNodes[2].textContent.trim(),
                remoteProblem: resultRow.childNodes[1].textContent.trim(),
                submitTime: resultRow.childNodes[8].textContent.trim(),
                judgeTime: resultRow.childNodes[9].textContent.trim(),
            },
        };
        return result;
    }
    catch (e) {
        throw e;
    }
};
const updateSolutionResults = async () => {
    for (const [runid, cb] of updateMap) {
        try {
            const result = await fetch(runid);
            cb(result);
            if (result.status !== interfaces_1.SolutionResult.Judging && result.status !== interfaces_1.SolutionResult.WaitingJudge) {
                updateMap.delete(runid);
            }
        }
        catch (e) {
            cb({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: e.message, runID: runid } });
        }
    }
    setTimeout(updateSolutionResults, UPDATE_INTERVAL);
};
const main = async (problem, solution, resolve, update) => {
    if (interfaces_1.Problem.guard(problem)) {
        if (interfaces_1.Solution.guard(solution)) {
            if (!await isLoggedIn()) {
                try {
                    await initRequest();
                }
                catch (e) {
                    return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: e.message } });
                }
            }
            try {
                let langname = null;
                if (solution.language === "c") {
                    langname = "C";
                }
                else if (solution.language === "cpp98") {
                    langname = "C++";
                }
                else if (solution.language === "cpp11") {
                    langname = "C++11";
                }
                else if (solution.language === "java") {
                    langname = "Java8";
                }
                else if (solution.language === "python3") {
                    langname = "Python3";
                }
                else if (solution.language === "python2") {
                    langname = "Python2.7";
                }
                if (langname === null) {
                    return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: "Language rejected" } });
                }
                const source = await resolve(solution.file);
                const stat = fs_1.statSync(source.path);
                if (stat.size > MAX_SOURCE_SIZE) {
                    return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: "File is too big" } });
                }
                const content = fs_1.readFileSync(source.path).toString();
                const runID = await submit(problem.id, content, langname);
                updateMap.set(runID, update);
            }
            catch (e) {
                log(e.message);
                return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: "Invalid solution" } });
            }
        }
        else {
            return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: "Invalid solution" } });
        }
    }
    else {
        return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: "Invalid problem" } });
    }
};
module.exports = main;
updateSolutionResults();
//# sourceMappingURL=index.js.map