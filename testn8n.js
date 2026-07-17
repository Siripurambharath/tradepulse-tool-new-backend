const express = require("express");

const app = express();

app.use(express.json());

// Sample Database (JSON)
let customers = [
    {
        id: 101,
        name: "John",
        phone: "9999999999",
        amc: true
    },
    {
        id: 102,
        name: "David",
        phone: "8888888888",
        amc: false
    }
];

let serviceRequests = [];

/*
---------------------------------
GET Customer API
---------------------------------
*/
app.get("/api/customer/:id", (req, res) => {

    const id = Number(req.params.id);

    const customer = customers.find(c => c.id === id);

    if (!customer) {
        return res.status(404).json({
            success: false,
            message: "Customer not found"
        });
    }

    res.json(customer);

});


/*
---------------------------------
POST Service Request
---------------------------------
*/
app.post("/api/service-request", (req, res) => {

    const request = {
        id: serviceRequests.length + 1,
        customerId: req.body.customerId,
        customerName: req.body.customerName,
        phone: req.body.phone,
        issue: req.body.issue,
        status: req.body.status
    };

    serviceRequests.push(request);

    res.json({
        success: true,
        message: "Service Request Created",
        data: request
    });

});


/*
---------------------------------
GET All Requests
---------------------------------
*/
app.get("/api/service-request", (req, res) => {

    res.json(serviceRequests);

});


app.listen(8000, () => {
    console.log("Server Running");
    console.log("http://localhost:8000");
});