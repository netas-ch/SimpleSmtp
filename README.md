# SimpleSmtp
A simple class to send E-Mails directly from Node JS.

## nice to know
* This library sends email directly to the receiving email server, to port 25. So this class is not for your development PC and not for your home-server, as many internet providers block outgoing port 25 due to spam reasons.

* You will need to add your server IP to your SPF record of your domain, otherwise it's unlikely that the email will pass the spam filter of the receiving provider.

* the library supports upgrade to TLS (encrypted) connection.

* When delivery fails, it retrys 4 times to retransmit the message.

* The class starts a interval to send the emails; so try to create only one instance of SimpleSmtp while running your programm.

* It was created to send status notifications to the server admin; so there is no HTML, formatting, etc.. Just plain text.


## usage
```javascript

// the domain name of your webserver
const mydomainname = 'mydomain.com';

// create instance (try to create just one while running your script!)
const SimpleSmtp = require('./SimpleSmtp.js');
const smtp = new SimpleSmtp(mydomainname);

// now send a email
smtp.sendMail(
  'noreply@' + mydomainname,                                                               // from (email-address)
  'info@netas.ch',                                                                         // to (email-address)
  'Testmail',                                                                              // subject
  "Hello!\nThis is a test of the famous SimpleSmtp NodeJS class provided by netas.ch!"     // mail body
);
```

## License
MIT License, Copyright © 2023 Lukas Buchs, [Netas AG](https://www.netas.ch)


