import fetch from 'node-fetch';

const RECAPTCHA_API_KEY = process.env.GOOGLE_CLOUD_API_KEY;
const RECAPTCHA_PROJECT_ID = 'coinixfaucet';

export async function verifyRecaptchaToken(token, action = 'auth') {
  try {
    const url = `https://recaptchaenterprise.googleapis.com/v1/projects/${RECAPTCHA_PROJECT_ID}/assessments?key=${RECAPTCHA_API_KEY}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: {
          token: token,
          expectedAction: action,
          siteKey: '6LctET4tAAAAAAGcqEdyQbF_gcTH57Dnxztlv2hN'
        }
      })
    });

    const assessment = await response.json();
    const riskScore = assessment.riskAnalysis?.score || 0;
    const reasons = assessment.riskAnalysis?.reasons || [];
    
    const isSafe = riskScore >= 0.5;
    const isValidAction = assessment.event?.expectedAction === action;
    
    return {
      success: isSafe && isValidAction,
      score: riskScore,
      reasons: reasons
    };
  } catch (error) {
    console.error('reCAPTCHA verification failed:', error);
    return { success: false, error: error.message };
  }
}

export default verifyRecaptchaToken;
