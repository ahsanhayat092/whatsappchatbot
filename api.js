const axios = require('axios');
const FormData = require('form-data');

const BASE_URL = process.env.API_BASE_URL || 'https://cms-pwasa.wasalhr.pk/api';

class PunjabCmsService {
    constructor() {
        this.token = null;
        this.tokenExpiresAt = null;
        
        // Bot API Credentials
        this.botUsername = process.env.BOT_USERNAME || 'wasa_bot_user';
        this.botPassword = process.env.BOT_PASSWORD || 'WasaBotPass123!';
        this.botCnic = process.env.BOT_CNIC || '35202-9999999-1';
        this.botEmail = process.env.BOT_EMAIL || 'wasabot@pwasa.wasalhr.pk';
        this.botPhone = process.env.BOT_PHONE || '+923000000000';
    }

    /**
     * Reverse Geocode GPS coordinates (Lat, Lng) into a human readable address string using Nominatim
     */
    async reverseGeocode(latitude, longitude) {
        try {
            console.log(`🌐 [GEOCODE] Reverse geocoding GPS coordinates: (${latitude}, ${longitude})...`);
            const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1`;
            const response = await axios.get(url, {
                headers: { 'User-Agent': 'PunjabWASAWhatsAppBot/1.0' },
                timeout: 5000
            });

            if (response.data && response.data.display_name) {
                const address = response.data.display_name;
                console.log(`📍 [GEOCODE SUCCESS]: "${address}"`);
                return address;
            }
        } catch (error) {
            console.error('⚠️ Reverse geocoding failed:', error.message);
        }
        return `GPS Pin Location (${latitude}, ${longitude})`;
    }

    /**
     * Authenticate and get JWT Token
     */
    async authenticate() {
        if (this.token && this.tokenExpiresAt && new Date() < this.tokenExpiresAt) {
            return this.token;
        }

        try {
            console.log(`\n🔑 [API AUTH] Authenticating bot (${this.botUsername}) with ${BASE_URL}...`);
            
            let loginRes;
            try {
                loginRes = await axios.post(`${BASE_URL}/auth/login`, {
                    username: this.botUsername,
                    password: this.botPassword
                });
            } catch (err) {
                if (err.response && err.response.status === 401) {
                    console.log('ℹ️ [API AUTH] Account not found. Auto-registering bot account...');
                    await this.registerBotAccount();
                    loginRes = await axios.post(`${BASE_URL}/auth/login`, {
                        username: this.botUsername,
                        password: this.botPassword
                    });
                } else {
                    throw err;
                }
            }

            if (loginRes?.data?.success && loginRes?.data?.data?.token) {
                this.token = loginRes.data.data.token;
                this.tokenExpiresAt = new Date(Date.now() + 7 * 60 * 60 * 1000);
                console.log('✅ [API AUTH] JWT Token obtained successfully!');
                return this.token;
            } else {
                return null;
            }
        } catch (error) {
            console.error('❌ [API AUTH FAILED]:', error.response?.data || error.message);
            return null;
        }
    }

    /**
     * Auto-Register Bot Account
     */
    async registerBotAccount() {
        try {
            const signupData = {
                username: this.botUsername,
                email: this.botEmail,
                password: this.botPassword,
                fullName: "Punjab WASA WhatsApp Bot",
                phoneNumber: this.botPhone,
                cnic: this.botCnic,
                cityId: 1
            };
            await axios.post(`${BASE_URL}/auth/signup`, signupData);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get Auth Headers
     */
    async getHeaders() {
        const token = await this.authenticate();
        if (token) {
            return { Authorization: `Bearer ${token}` };
        }
        return {};
    }

    /**
     * Track a complaint by ID (Public API)
     */
    async trackComplaint(complaintId) {
        const url = `${BASE_URL}/complaint/track`;
        const payload = { complaintId: parseInt(complaintId, 10) };

        console.log('\n==================================================');
        console.log(`🌐 [API REQUEST] POST ${url}`);
        console.log('PAYLOAD:', JSON.stringify(payload, null, 2));

        try {
            const response = await axios.post(url, payload);
            console.log('--------------------------------------------------');
            console.log(`📥 [API RESPONSE] Status: ${response.status} OK`);
            console.log('DATA:', JSON.stringify(response.data, null, 2));
            console.log('==================================================\n');
            return response.data;
        } catch (error) {
            console.log('--------------------------------------------------');
            console.log(`❌ [API RESPONSE ERROR]:`, JSON.stringify(error.response?.data || error.message, null, 2));
            console.log('==================================================\n');
            return error.response?.data || { success: false, message: 'Network error tracking complaint' };
        }
    }

    /**
     * Get list of Cities
     */
    async getCities() {
        try {
            const response = await axios.get(`${BASE_URL}/location/cities`);
            return response.data;
        } catch (error) {
            return { success: false, data: [] };
        }
    }

    /**
     * Get Complaint Types
     */
    async getComplaintTypes() {
        try {
            const headers = await this.getHeaders();
            const response = await axios.get(`${BASE_URL}/complaint/types`, { headers });
            return response.data;
        } catch (error) {
            return {
                success: true,
                data: [
                    { id: 2, name: 'Operations', description: 'Operations' },
                    { id: 1, name: 'Revenue', description: 'Revenue' }
                ]
            };
        }
    }

    /**
     * Get Complaint Subtypes by Type ID
     */
    async getComplaintSubtypes(typeId) {
        try {
            const headers = await this.getHeaders();
            const response = await axios.get(`${BASE_URL}/complaint/subtypes?typeId=${typeId}`, { headers });
            return response.data;
        } catch (error) {
            return { success: false, data: [] };
        }
    }

    /**
     * Lookup Consumer Details by Account Number
     */
    async lookupConsumer(cityId, accountNo) {
        const url = `${BASE_URL}/complaint/lookup-consumer?cityId=${cityId}&accountNo=${encodeURIComponent(accountNo)}`;
        
        console.log('\n==================================================');
        console.log(`🌐 [API REQUEST] GET ${url}`);

        try {
            const headers = await this.getHeaders();
            const response = await axios.get(url, { headers });
            console.log('--------------------------------------------------');
            console.log(`📥 [API RESPONSE] Status: ${response.status} OK`);
            console.log('DATA:', JSON.stringify(response.data, null, 2));
            console.log('==================================================\n');
            return response.data;
        } catch (error) {
            console.log('--------------------------------------------------');
            console.log(`❌ [API RESPONSE ERROR]:`, JSON.stringify(error.response?.data || error.message, null, 2));
            console.log('==================================================\n');
            return { success: false, data: { consumerFound: false } };
        }
    }

    /**
     * Submit a New Complaint (ALWAYS multipart/form-data for ASP.NET Core [FromForm])
     */
    async createComplaint(complaintData, imageBuffer = null, imageName = 'photo.jpg') {
        const url = `${BASE_URL}/complaint`;
        
        console.log('\n==================================================');
        console.log(`🌐 [API REQUEST] POST ${url}`);
        console.log('FORM PAYLOAD:', JSON.stringify(complaintData, null, 2));
        if (imageBuffer) console.log(`ATTACHMENT: Image file included (${imageName})`);

        try {
            const headers = await this.getHeaders();
            const form = new FormData();

            Object.keys(complaintData).forEach(key => {
                const val = complaintData[key];
                if (val !== null && val !== undefined) {
                    form.append(key, String(val));
                }
            });

            if (imageBuffer) {
                form.append('images', imageBuffer, { filename: imageName, contentType: 'image/jpeg' });
            }

            const response = await axios.post(url, form, {
                headers: {
                    ...headers,
                    ...form.getHeaders()
                }
            });

            console.log('--------------------------------------------------');
            console.log(`📥 [API RESPONSE] Status: ${response.status} OK`);
            console.log('RESPONSE DATA:', JSON.stringify(response.data, null, 2));
            console.log('==================================================\n');

            return response.data;
        } catch (error) {
            console.log('--------------------------------------------------');
            console.log(`❌ [API RESPONSE ERROR]:`, JSON.stringify(error.response?.data || error.message, null, 2));
            console.log('==================================================\n');
            
            const errData = error.response?.data;
            if (errData) {
                let errorMessages = [];
                if (errData.errors) {
                    if (Array.isArray(errData.errors)) {
                        errorMessages = errData.errors;
                    } else if (typeof errData.errors === 'object') {
                        Object.keys(errData.errors).forEach(k => {
                            const errList = errData.errors[k];
                            if (Array.isArray(errList)) {
                                errorMessages.push(...errList);
                            } else {
                                errorMessages.push(String(errList));
                            }
                        });
                    }
                }
                return {
                    success: false,
                    message: errData.title || errData.message || 'Validation failed',
                    errorList: errorMessages
                };
            }
            return { success: false, message: 'Failed to create complaint due to network error' };
        }
    }
}

module.exports = new PunjabCmsService();
