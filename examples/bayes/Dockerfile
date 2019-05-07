FROM python:3.7
COPY . /app
RUN ["pip","install","Theano==0.8.2"]
RUN ["pip","install","Lasagne==0.1"]
CMD ["python","/app/bayes.py"]