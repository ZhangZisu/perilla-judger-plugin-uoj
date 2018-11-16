import { readFileSync, statSync } from "fs";
import { Browser, launch } from "puppeteer";
import { ISolution, JudgeFunction, Problem, Solution, SolutionResult } from "./interfaces";

const MAX_SOURCE_SIZE = 16 * 1024 * 1024;
const UPDATE_INTERVAL = 1000;

const config = JSON.parse(readFileSync("config.json").toString());
let browser: Browser = null;

if (!config.uoj_addr.endsWith("/")) { config.uoj_addr = config.uoj_addr + "/"; }

const getURL = (url: string) => {
    if (url.startsWith("/")) { return config.uoj_addr + url.substr(1); }
    return config.uoj_addr + url;
};

const isLoggedIn = async () => {
    if (!browser) { return false; }
    const page = await browser.newPage();
    try {
        const res = await page.goto(getURL("user/msg"));
        const failed = (res.status() !== 200) || !(/私信/.test(await res.text()));
        await page.close();
        return !failed;
    } catch (e) {
        await page.close();
        return false;
    }
};

const initRequest = async () => {
    // tslint:disable-next-line:no-console
    console.log("[INFO] [UOJ] Puppeteer is initializing");
    browser = await launch();
    const page = await browser.newPage();
    try {
        await page.goto(getURL("login"));
        await page.evaluate((username: string, password: string) => {
            const usr: any = document.querySelector("#input-username");
            const pwd: any = document.querySelector("#input-password");
            usr.value = username;
            pwd.value = password;
            const btn: any = document.querySelector("#button-submit");
            btn.click();
        }, config.username, config.password);
        await page.waitForNavigation();
        if (!await isLoggedIn()) {
            throw new Error("Login failed");
        }
        await page.close();
        // tslint:disable-next-line:no-console
        console.log("[INFO] [UOJ] Puppeteer is initialized");
    } catch (e) {
        await page.close();
        throw e;
    }
};

const submit = async (id: number, code: string, langname: string) => {
    const page = await browser.newPage();
    try {
        await page.goto(getURL("problem/" + id));
        const success = await page.evaluate((lang: string, sourcecode: string) => {
            const submitBtn: any = document.querySelector("body > div.container.theme-showcase > div.uoj-content > ul > li:nth-child(2) > a");
            if (!submitBtn) { return false; }
            submitBtn.click();
            const langEle: any = document.querySelector("#input-answer_answer_language");
            if (!langEle) { return false; }
            const codeEle: any = document.querySelector("#input-answer_answer_editor");
            if (!codeEle) { return false; }
            langEle.value = lang;
            codeEle.value = sourcecode;
            const btn: any = document.querySelector("#button-submit-answer");
            btn.click();
            return true;
        }, langname, code);
        if (!success) { throw new Error("Submit failed"); }
        await page.waitForNavigation();
        const unparsedID: string = await page.evaluate((username: string) => {
            const tbody: any = document.querySelector("body > div > div.uoj-content > div.table-responsive > table > tbody");
            // tslint:disable-next-line:prefer-for-of
            for (let i = 0; i < tbody.children.length; i++) {
                const tr = tbody.children[i];
                if (tr.getAttribute("class") === "info") { continue; }
                const user = tr.children[2].textContent.trim();
                if (user === username) { return tr.children[0].textContent.trim().substr(1); }
            }
            return null;
        }, config.username);
        if (unparsedID === null) { throw new Error("Submit failed"); }
        await page.close();
        return parseInt(unparsedID, 10);
    } catch (e) {
        await page.close();
        throw e;
    }
};
const updateMap = new Map<number, (solution: ISolution) => Promise<void>>();

const convertStatus = (text: string) => {
    try {
        const score = parseInt(text, 10);
        if (score < 0 || score > 100 || isNaN(score)) { throw new Error("Invalid score"); }
        // Cannot parse error
        return {
            score,
            status: score === 100 ? SolutionResult.Accepted : SolutionResult.OtherError,
        };
    } catch (e) {
        switch (text) {
            case "Waiting":
            case "Waiting Rejudge":
                return { status: SolutionResult.WaitingJudge, score: 0 };
            case "Compiling":
            case "Judging":
                return { status: SolutionResult.Judging, score: 0 };
            case "Compile Error":
                return { status: SolutionResult.CompileError, score: 0 };
            case "Judgement Failed":
                return { status: SolutionResult.JudgementFailed, score: 0 };
        }
        return {
            status: SolutionResult.OtherError,
            score: 0,
        };
    }
};

const fetch = async (runID: number) => {
    const page = await browser.newPage();
    try {
        await page.goto(getURL("submission/" + runID));
        const { memory, time, statusText } = await page.evaluate(() => {
            const mEle = document.querySelector("body > div > div.uoj-content > div.table-responsive > table > tbody > tr > td:nth-child(5)");
            const tEle = document.querySelector("body > div > div.uoj-content > div.table-responsive > table > tbody > tr > td:nth-child(6)");
            const sEle = document.querySelector("body > div > div.uoj-content > div.table-responsive > table > tbody > tr > td:nth-child(4)");
            return {
                memory: mEle.textContent.trim(),
                time: tEle.textContent.trim(),
                statusText: sEle.textContent.trim(),
            };
        });
        const { status, score } = convertStatus(statusText);
        const result: ISolution = {
            status,
            score,
            details: {
                time,
                memory,
            },
        };
        await page.close();
        return result;
    } catch (e) {
        await page.close();
        throw e;
    }
};

const updateSolutionResults = async () => {
    for (const [runid, cb] of updateMap) {
        try {
            const result = await fetch(runid);
            cb(result);
            if (result.status !== SolutionResult.Judging && result.status !== SolutionResult.WaitingJudge) {
                updateMap.delete(runid);
            }
        } catch (e) {
            cb({ status: SolutionResult.JudgementFailed, score: 0, details: { error: e.message } });
        }
    }
    setTimeout(updateSolutionResults, UPDATE_INTERVAL);
};

const main: JudgeFunction = async (problem, solution, resolve, update) => {
    if (Problem.guard(problem)) {
        if (Solution.guard(solution)) {
            if (!browser) {
                try {
                    await initRequest();
                } catch (e) {
                    browser = null;
                    return update({ status: SolutionResult.JudgementFailed, score: 0, details: { error: e.message } });
                }
            }
            try {
                let langname = null;
                if (solution.language === "c") {
                    langname = "C";
                } else if (solution.language === "cpp98") {
                    langname = "C++";
                } else if (solution.language === "cpp11") {
                    langname = "C++11";
                } else if (solution.language === "java") {
                    langname = "Java8";
                } else if (solution.language === "python3") {
                    langname = "Python3";
                } else if (solution.language === "python2") {
                    langname = "Python2.7";
                }
                if (langname === null) {
                    return update({ status: SolutionResult.JudgementFailed, score: 0, details: { error: "Language rejected" } });
                }
                const source = await resolve(solution.file);
                const stat = statSync(source.path);
                if (stat.size > MAX_SOURCE_SIZE) {
                    return update({ status: SolutionResult.JudgementFailed, score: 0, details: { error: "File is too big" } });
                }
                const content = readFileSync(source.path).toString();
                const runID = await submit(problem.id, content, langname);
                updateMap.set(runID, update);
            } catch (e) {
                return update({ status: SolutionResult.JudgementFailed, score: 0, details: { error: "Invalid solution" } });
            }
        } else {
            return update({ status: SolutionResult.JudgementFailed, score: 0, details: { error: "Invalid solution" } });
        }
    } else {
        return update({ status: SolutionResult.JudgementFailed, score: 0, details: { error: "Invalid problem" } });
    }
};

module.exports = main;

updateSolutionResults();
