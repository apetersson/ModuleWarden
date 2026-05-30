# 4 Login to LEONARDO
Source: https://ai-at.eu/hpc-onboarding/chapter-4

---

Access to LEONARDO, CINECA's EuroHPC supercomputer, is based on **certificate-based authentication**. To manage these temporary certificates, users need the **step client**, which creates and renews ssh certificates securely.

This guide walks you through the full process of installing the step client, obtaining a certificate, and logging in to LEONARDO for the first time.

**Step 1: Install the step client**

On macOS, install the step client using **Homebrew (you might have to install brew first)**:

`brew install step`

(For other operating systems, see the official step documentation at https://smallstep.com/docs/step-ca/installation )

* * *

**Step 2: Bootstrap the Certificate Authority (CA)**

Next, configure your step client to trust CINECA's certificate authority. Run:

`step ca bootstrap --ca-url=https://sshproxy.hpc.cineca.it \   --fingerprint 2ae1543202304d3f434bdc1a2c92eff2cd2b02110206ef06317e70c1c1735ecd`

This ensures the step client communicates securely with LEONARDO's authentication system.

* * *

**Step 3: Start the ssh Agent**

The ssh agent stores your credentials temporarily during the session. Start it with:

`eval $(ssh-agent)`

* * *

**Step 4: Request Your ssh Certificate**

You can now request a **short-lived ssh certificate** for secure access.

`step ssh login 'USER@EMAIL' --provisioner cineca-hpc`

You'll be redirected to your institution's identity provider, where you authenticate using your password and one-time code.

* * *

**Step 5: Connect to LEONARDO**

Once the certificate is issued, connect to LEONARDO using:

`ssh yourusername@login.LEONARDO.cineca.it`

To end the session:

`logout`

* * *

**Step 6: Handling Common Issues**

If you see a message saying _"REMOTE HOST IDENTIFICATION HAS CHANGED"_, remove the outdated entry from your known hosts:

`nano ~/.ssh/known_hosts`

Delete the line corresponding to LEONARDO, then save and retry.
Alternatively, connect directly to a specific login node:

`ssh yourusername@login01-ext.LEONARDO.cineca.it`

* * *

**Step 7: Simplify Your Workflow**

To avoid repeating long commands, configure your ssh client. Open the configuration file:

`nano ~/.ssh/config`

Add the following block (adjusting the username and email as needed):

```
Host LEONARDO
    HostName login.leonardo.cineca.it
    User yourusername
```

Now you can log in simply by typing:

`ssh LEONARDO`

Your ssh certificate will automatically renew if it's close to expiring.

Once you've completed these steps, you're ready to connect to LEONARDO and begin working securely on CINECA's high-performance computing systems.
For troubleshooting and advanced configuration, refer to the official CINECA documentation.
