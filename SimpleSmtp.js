'use strict';

const tls = require('tls');
const dns = require('dns');
const net = require('net');

module.exports = class SimpleSmtp {
    #smtpPort = 25;
    #retryInterval = 1000*60*4; // 4 Min
    #retryTimes = 4; // 4x
    #hostname;
    #queue = [];

    constructor(hostname) {
        this.#hostname = hostname;

        if (!hostname) {
            throw new Error('invalid hostname');
        }

        setInterval(() => {
            this.#handleQueue();
        }, 5000);

    }

    // -----------
    // PUBLIC
    // -----------

    sendMail(from, to, subject, text) {
        this.#queue.push({
            from: from,
            to: to,
            subject: subject,
            text: text,

            sent: false,
            try: 0,
            lastTry: null
        });
    }


    // -----------
    // PRIVATE
    // -----------

    async #handleQueue() {
        let obj = null;
        for (let i = 0; i < this.#queue.length; i++) {
            if (!this.#queue[i].sent && this.#queue[i].try < this.#retryTimes) {
                if (!this.#queue[i].lastTry || (this.#queue[i].lastTry && this.#queue[i].lastTry.getTime() < (Date.now() - this.#retryInterval))) {
                    obj = this.#queue[i];
                    break;
                }
            }
        }

        if (obj) {
            obj.try++;
            obj.lastTry = new Date();

            try {
                await this.#sendMail(obj.from, obj.to, obj.subject, obj.text);
                obj.sent = true;

                this.#queue.splice(this.#queue.indexOf(obj), 1);

            } catch (e) {
                // not sent
            }
        }
    }

    async #sendMail(from, to, subject, text) {
        let socket;
        try {

            let connectHost = await this.#resolveMx(this.#getHostFromMail(to));
            let data = this.#buildMail(from, to, subject, text);

            socket = net.createConnection(this.#smtpPort, connectHost);
            socket.setTimeout(5000);

            await this.#socketWaitReady(socket);
            await this.#sendToSmtp(socket, connectHost, from, to, data);

        } catch (e) {
            if(socket) {
                socket.end();
            }
        }
    }

    async #sendToSmtp(socket, hostname, from, to, data) {

        // S: 220 mail.example.org ESMTP service ready
        if (!await this.#waitForMessage(socket, 220)) {
            throw new Error('invalid response: service not ready');
        }

        socket.write('EHLO ' + this.#hostname + "\r\n");

        // Upgrade to TLS?
        let mailSocket = socket;
        if (await this.#waitForMessage(socket, 250, 'STARTTLS')) {
            socket.write('STARTTLS' + "\r\n");

            if (await this.#waitForMessage(socket, 220)) { // 220 Go ahead
                mailSocket = this.#upgradeToTls(socket, hostname);

                // SSL erneut
                mailSocket.write('EHLO ' + this.#hostname + "\r\n");

                if (!await this.#waitForMessage(mailSocket, 250)) { // 250 Hello relay.example.org, I am glad to meet you
                    throw new Error('invalid response: no response 250 to EHLO (SSL)');
                }
            }
        }

        // FROM
        mailSocket.write('MAIL FROM:<' + from + ">\r\n");
        if (!await this.#waitForMessage(mailSocket, 250)) { // 250 Ok
            throw new Error('invalid response: no response 250 to FROM');
        }

        // TO
        mailSocket.write('RCPT TO:<' + to + ">\r\n");
        if (!await this.#waitForMessage(mailSocket, 250)) { // 250 Ok
            throw new Error('invalid response: no response 250 to TO');
        }

        // DATA
        mailSocket.write('DATA' + "\r\n");
        if (!await this.#waitForMessage(mailSocket, 354)) { // 354 End data with <CR><LF>.<CR><LF>
            throw new Error('invalid response: no response 354 to DATA');
        }

        // (Send Data)
        data = data.replaceAll("\r\n.\r\n", "\r\n..\r\n");
        mailSocket.write(data + "\r\n.\r\n");

        if (!await this.#waitForMessage(mailSocket, 250, null, 5000)) { // 250 Ok: queued as 12345
            throw new Error('invalid response: no response 250 to data');
        }
        
        // QUIT
        mailSocket.write('QUIT' + "\r\n");
        if (!await this.#waitForMessage(mailSocket, 221)) { // 221 Bye
            throw new Error('invalid response: no response 221 to data');
        }

        mailSocket.end();
    }

    #buildMail(from, to, subject, plainText) {
        const headers = {
            From: from,
            To: to,
            Subject: subject || '(no subject)',
            Date: (new Date()).toGMTString()
        };

        headers['Message-Id'] = '<' + this.#createMessageId(from) + '>';
        headers['MIME-Version'] = '1.0';
        headers['Content-Transfer-Encoding'] = '8bit';
        headers['Content-Type'] = 'text/plain; charset=UTF-8';

        let mail = '';
        for (let header in headers) {
            mail += header + ': ' + headers[header] + "\r\n";
        }

        mail += "\r\n";
        mail += plainText || '(no message body)';

        return mail;
    }

    #upgradeToTls(socket, hostname) {
        return tls.connect({
            host: hostname,
            port: this.#smtpPort,
            socket: socket,
            checkServerIdentity: (servername, cert) => { return; }
        });
    }

    async #waitForMessage(socket, code=null, message=null, timeout=3000) {
        while (true) {
            const rep = await this.#getNextMessageFromSocket(socket, timeout);
            if (rep && (code === null || rep.code === code) && (message === null || rep.msg === message)) {
                return true;
            } else if (!rep) {
                return false;
            }
        }
    }

    async #getNextMessageFromSocket(socket, timeout=50) {
        const startTime = Date.now();
        socket.setEncoding('utf8');
        let buf = '';

        while ((startTime + timeout) > Date.now() && socket.readable) {
            let byte = socket.read(1);
            if (byte !== null) {
                buf += byte;
            } else {
                await this.#sleep(5);
            }

            if (buf && buf.length >= 2 && buf.substr(buf.length-2) === "\r\n") {
                break;
            }
        }

        if (buf) {
            const parts = buf.trim().match(/^([0-9]+)(?: |\-)(.+)$/);
            if (parts) {
                return {
                    code: parseInt(parts[1]),
                    msg: parts[2].trim()
                };
            } else {
                return {
                    code: null,
                    msg: buf.trim()
                };
            }
        }

        return null;
    }

    #socketWaitReady(socket, timeout=3000) {
        return new Promise((resolve, reject) => {
            let ok = false;
           socket.once('ready', () => {
               ok = true;
               resolve();
           });
           setTimeout(() => {
               if (!ok) {
                   reject();
               }
           }, timeout);
        });
    }


    #sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    #createMessageId(fromMail) {
        return this.#generateRandomID(10) + '.' + this.#generateRandomID(10) + '@' + this.#getHostFromMail(fromMail);
    }

    #generateRandomID(length) {
        const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let randomID = '';
        for (let i = 0; i < length; i++) {
          const randomIndex = Math.floor(Math.random() * charset.length);
          randomID += charset.charAt(randomIndex);
        }
        return randomID;
    }

    #getHostFromMail(mail) {
        let match = mail.match(/^[^@]+@([^@]+\.[a-zA-Z]+$)/);
        if (match) {
            return match[1].toLowerCase();
        }
        throw new Error('invalid email: ' + mail);
    }

    #resolveMx(hostname) {
        return new Promise((resolve) => {
            dns.resolveMx(hostname, (err, addr) => {
                if (err) {
                    resolve(hostname);
                }
                if (addr && addr.length > 0 && addr[0].exchange) {
                    resolve(addr[0].exchange);
                } else {
                    resolve(hostname);
                }
            });
        });
    }

};